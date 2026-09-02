/**
 * Hook Socket — HTTP server on a Unix domain socket, shared by all agent
 * clients on the machine. Served by exactly one process at a time: the
 * standalone waykeep-daemon service when installed, otherwise the first agent
 * client's MCP server to start (embedded mode). Ownership is arbitrated by
 * the cooperative claim protocol in socket-ownership.ts — a live owner is
 * never displaced, so concurrent clients (Claude Code + Codex) coexist.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import { writeFileSync, chmodSync } from 'node:fs';
import type { Server as McpInnerServer } from '@modelcontextprotocol/sdk/server/index.js';
import { acquireSocketClaim, releaseSocketClaim, ensureWaykeepDirSecure, isOwnerOnly, socketPath, pidPath } from './socket-ownership.js';
import { FS_PERMS } from '../constants/index.js';
import { CLIENT_HEADER } from '../constants/clients.js';
import { CONTRACT_REVISION } from 'waykeep-contract';
import type { HookDbClient, CachedHookContext } from '../hooks/shared/db-client.js';
import { OwnerRpc } from './owner-rpc.js';
import { normalizeHookInput } from '../hooks/shared/client-adapter.js';
import { SessionCache } from '../hooks/shared/session-cache.js';
import { saveTracker } from '../hooks/shared/edit-tracker.js';
import { handlePitfallCheck } from '../hooks/handlers/pitfall-handler.js';
import { handlePromptCheck } from '../hooks/handlers/prompt-handler.js';
import { handleSuccessTracker } from '../hooks/handlers/success-tracker-handler.js';
import { handleErrorLearning } from '../hooks/handlers/error-learning-handler.js';
import { handleCodexPostTool } from '../hooks/handlers/codex-post-tool-handler.js';
import { handleStop } from '../hooks/handlers/stop-handler.js';
import { handleStopFailure } from '../hooks/handlers/stop-failure-handler.js';
import { handleFileChanged } from '../hooks/handlers/file-changed-handler.js';
import { handleSubagentContext } from '../hooks/handlers/subagent-context-handler.js';
import { handleSubagentStop } from '../hooks/handlers/subagent-stop-handler.js';
import { handlePlanBridge } from '../hooks/handlers/plan-bridge-handler.js';
import { handlePostCompact } from '../hooks/handlers/postcompact-handler.js';
import { handleStatusLine } from '../hooks/handlers/statusline-handler.js';
import { handleSessionStart } from '../hooks/handlers/session-start-handler.js';
import { recordTelemetry } from '../hooks/shared/hook-telemetry.js';
import { evaluateGovernanceWarnStop } from '../governance/warn-stop.js';

// --- Constants ---
const REQUEST_TIMEOUT_MS = 5000;

/** Who may serve the socket: an agent client's MCP server (embedded) or the
 *  standalone waykeep-daemon service. Reported via /health for diagnostics. */
export type HookSocketMode = 'embedded' | 'standalone';

// --- Helpers ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => chunks.push(chunk);
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf-8')); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    // On timeout, destroy the request and detach listeners — a stalled client
    // would otherwise keep feeding chunks into an array nobody will read.
    const timeout = setTimeout(() => {
      cleanup();
      req.destroy();
      reject(new Error('Request body timeout'));
    }, REQUEST_TIMEOUT_MS);
    function cleanup(): void {
      clearTimeout(timeout);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

// --- Route table ---

type RouteHandlerResult = {
  output?: string | null;
  [key: string]: unknown;
};

/** Route entries erase their concrete input type to `never` at this
 *  boundary: handlers receive the parsed-but-unvalidated request body, so
 *  the single dispatch-site cast (`input as never`) is the honest place
 *  for the unsoundness — entry callbacks that READ input fields annotate
 *  the fields they use (contravariance makes that assignable). Result
 *  fields are `unknown` via the index signature; string readers wrap in
 *  String(...). */
type RouteHandler = (input: never, client: CachedHookContext) =>
  | RouteHandlerResult
  | Promise<RouteHandlerResult>;

const routes: Record<string, {
  handler: RouteHandler;
  telemetryName: string;
  extractEventType: (input: never, result: RouteHandlerResult) => string;
  extractMeta?: (input: never, result: RouteHandlerResult) => Record<string, unknown>;
}> = {
  '/pitfall-check': {
    handler: (input, c) => {
      const r = handlePitfallCheck(input, c);
      return { output: r.output, pitfallsSurfaced: r.pitfallsSurfaced };
    },
    telemetryName: 'pitfall-check',
    extractEventType: (input: { tool_name?: string }) => input.tool_name ?? 'unknown',
    extractMeta: (_input, result) => ({ pitfallsSurfaced: result.pitfallsSurfaced, daemon: true }),
  },
  '/prompt-check': {
    handler: (input, c) => {
      const r = handlePromptCheck(input, c);
      return { output: r.output, intent: r.intent, injections: r.injections };
    },
    telemetryName: 'prompt-check',
    extractEventType: (_input, result) => String(result.intent ?? 'unknown'),
    extractMeta: (_input, result) => ({ injections: result.injections, daemon: true }),
  },
  '/success-tracker': {
    handler: async (input, c) => {
      const r = await handleSuccessTracker(input, c);
      return { output: null, tracked: r.tracked };
    },
    telemetryName: 'success-tracker',
    extractEventType: (input: { tool_name?: string }) => input.tool_name ?? 'unknown',
    extractMeta: (_input, result) => ({ daemon: true, tracked: result.tracked }),
  },
  '/error-learning': {
    handler: async (input, c) => {
      const r = await handleErrorLearning(input, c);
      return { output: r.output, action: r.action, sessionCount: r.sessionCount };
    },
    telemetryName: 'error-learning',
    extractEventType: (_input, result) => String(result.action ?? 'unknown'),
    extractMeta: (_input, result) => ({ daemon: true, sessionCount: result.sessionCount }),
  },
  '/stop': {
    handler: async (input, c) => {
      const r = await handleStop(input, c);
      // M2: flush dirty trackers at end of every turn. session-end is a
      // standalone hook that reads the tracker from disk; without this its
      // resume cursor could be up to TRACKER_FLUSH_INTERVAL_MS (60s) stale.
      // Stop bounds the staleness to one turn.
      c.cache?.flushDirtyTrackers();
      return {
        output: null,
        action: r.action,
        sigilCount: r.sigilCount,
        reflectionCount: r.reflectionCount,
        pendingNudge: r.pendingNudge,
      };
    },
    telemetryName: 'stop',
    extractEventType: (_input, result) => String(result.action ?? 'unknown'),
    extractMeta: (_input, result) => ({
      sigils: result.sigilCount ?? 0,
      reflected: result.reflectionCount ?? 0,
      nudge: result.pendingNudge ?? 0,
    }),
  },
  '/bump-memory-version': {
    // Cross-process skip-gate invalidation: MCP servers that share this
    // socket (rather than owning it) relay their write-tool bumps here so
    // corrections keep their zero staleness bound across processes.
    handler: (_input, c) => {
      c.cache?.bumpMemoryVersion();
      return { output: null };
    },
    telemetryName: 'bump-memory-version',
    extractEventType: () => 'bump',
  },
  '/governance-gate': {
    handler: async (input, c) => ({ output: await evaluateGovernanceWarnStop(c.db, input) }),
    telemetryName: 'governance-gate',
    extractEventType: () => 'warn-evaluation',
    extractMeta: (_input, result) => ({ daemon: true, visible: Boolean(result.output) }),
  },
  '/stop-failure': {
    handler: (input, c) => {
      const r = handleStopFailure(input, c);
      return { output: null, errorType: r.errorType, pitfallCreated: r.pitfallCreated };
    },
    telemetryName: 'stop-failure',
    extractEventType: (_input, result) => String(result.errorType ?? 'unknown'),
  },
  '/file-changed': {
    handler: async (input, c) => {
      const r = await handleFileChanged(input, c);
      return { output: r.output, remindersTriggered: r.remindersTriggered };
    },
    telemetryName: 'file-changed',
    extractEventType: () => 'check',
    extractMeta: (_input, result) => ({ daemon: true, remindersTriggered: result.remindersTriggered }),
  },
  '/subagent-context': {
    handler: (input, c) => {
      const r = handleSubagentContext(input, c);
      return { output: r.output, hasPlan: r.hasPlan, pitfalls: r.pitfalls, corrections: r.corrections };
    },
    telemetryName: 'subagent-context',
    extractEventType: (input: { agent_type?: string }) => input.agent_type ?? 'unknown',
    extractMeta: (_input, result) => ({
      daemon: true,
      hasPlan: result.hasPlan,
      pitfalls: result.pitfalls,
      corrections: result.corrections,
    }),
  },
  '/subagent-stop': {
    handler: (input, c) => {
      const r = handleSubagentStop(input, c);
      return { output: null, noted: r.noted };
    },
    telemetryName: 'subagent-stop',
    extractEventType: (input: { agent_type?: string }) => input.agent_type ?? 'unknown',
  },
  '/plan-bridge': {
    handler: (input, c) => {
      const r = handlePlanBridge(input, c);
      return { output: r.output, action: r.action, steps: r.steps };
    },
    telemetryName: 'plan-bridge',
    extractEventType: (_input, result) => String(result.action ?? 'unknown'),
    extractMeta: (_input, result) => ({ daemon: true, steps: result.steps }),
  },
  '/postcompact': {
    handler: (input, c) => {
      const r = handlePostCompact(input, c);
      return { output: null, tokensSaved: r.tokensSaved };
    },
    telemetryName: 'postcompact',
    extractEventType: (input: { trigger?: string }) => input.trigger ?? 'auto',
    extractMeta: (_input, result) => ({ daemon: true, tokensSaved: result.tokensSaved }),
  },
  // Codex PostToolUse demux: rollout-lookup ground truth routes each event
  // to error-learning or success-tracker (Codex payloads carry no failure
  // signal of their own).
  '/post-tool': {
    handler: async (input, c) => {
      const r = await handleCodexPostTool(input, c);
      return { output: r.output, action: r.action, exitCode: r.exitCode };
    },
    telemetryName: 'post-tool',
    extractEventType: (input: { tool_name?: string }) => input.tool_name ?? 'unknown',
    extractMeta: (_input, result) => ({ daemon: true, action: result.action, exitCode: result.exitCode }),
  },
  // DEPRECATED alias of /post-tool — served for installs whose trusted
  // hook wiring names it (D3: async 404s are silent, so the alias lives
  // until a doctor-guided init migration retires it).
  '/codex-post-tool': {
    handler: async (input, c) => {
      const r = await handleCodexPostTool(input, c);
      return { output: r.output, action: r.action, exitCode: r.exitCode };
    },
    telemetryName: 'codex-post-tool',
    extractEventType: (input: { tool_name?: string }) => input.tool_name ?? 'unknown',
    extractMeta: (_input, result) => ({ daemon: true, action: result.action, exitCode: result.exitCode }),
  },
  '/session-start': {
    handler: (input, c) => {
      const r = handleSessionStart(input, c);
      return {
        output: r.output,
        sessionType: r.sessionType,
        interrupted: r.interrupted,
        tokenEstimate: r.tokenEstimate,
      };
    },
    telemetryName: 'session-start',
    extractEventType: (_input, result) => String(result.sessionType ?? 'unknown'),
    extractMeta: (_input, result) => ({
      daemon: true,
      tokenEstimate: result.tokenEstimate,
      interrupted: result.interrupted,
    }),
  },
};

/** Names of every served hook route — exported so the contract drift
 *  guard can assert the contract's route classification matches reality. */
export const SERVED_HOOK_ROUTES: readonly string[] = Object.keys(routes).map((r) => r.slice(1));

/**
 * Start the hook socket server in this process, if no other process already
 * serves it. Shares the caller's DB connection — no duplicate repos.
 *
 * Ownership is cooperative (see socket-ownership.ts): when a live owner —
 * the standalone waykeep-daemon or another agent client's MCP server —
 * answers the health probe, this resolves null and the caller must share
 * that socket instead. Live owners are NEVER signalled or displaced; only
 * a dead socket is claimed.
 *
 * The sessionCache parameter is optional for backward compatibility but should
 * always be provided in normal operation so MCP write tools can invalidate
 * skip-gate entries via bumpMemoryVersion(). If omitted, a local cache is
 * created and skip-gate invalidation on MCP writes won't work.
 */
export async function startHookSocket(
  client: HookDbClient,
  sessionCache?: SessionCache,
  innerServer?: McpInnerServer,
  options?: { mode?: HookSocketMode },
): Promise<HttpServer | null> {
  const dir = ensureWaykeepDirSecure();
  // Fail-closed: the 0700 dir is the socket's primary access control. If it
  // cannot be proven owner-only (chmod ignored on an exotic FS, or a
  // pre-existing wrong-owned dir), refuse to serve — hooks fall back to
  // direct-node execution, which is safe, rather than exposing the socket.
  if (!isOwnerOnly(dir, { followSymlink: true })) {
    console.error(
      `[waykeep] Refusing to serve hook socket: ${dir} is not owner-only — hooks will use the direct-node fallback`,
    );
    return null;
  }
  const mode: HookSocketMode = options?.mode ?? 'embedded';

  const claim = await acquireSocketClaim();
  if (!claim.claimed) {
    console.error(
      `[waykeep] Hook socket already served by PID ${claim.ownerPid ?? 'unknown'} — sharing it, not claiming`,
    );
    return null;
  }

  // Use the shared session cache if provided, else create an isolated one.
  // Sharing matters for skip-gate invalidation from MCP write tools.
  const cache = sessionCache ?? new SessionCache();

  // Build cached context — extends HookDbClient with session cache and,
  // when available, the MCP inner server (for sampling-backed hook
  // features like the Layer 1c Socratic reflection in stop-handler).
  const cachedClient: CachedHookContext = { ...client, cache, innerServer };

  // Owner-control RPC (D3): a SEPARATE route registry — never merged
  // into the hook route table or generated hook wiring.
  const ownerRpc = new OwnerRpc({ db: client.db, cache });

  const startupTime = Date.now();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();

    // StatusLine — high-frequency, no telemetry, plain text response
    if (req.method === 'POST' && req.url === '/statusline') {
      let body: string;
      try { body = await readBody(req); } catch { res.writeHead(400); res.end(''); return; }
      try {
        const input = JSON.parse(body);
        const r = handleStatusLine(input, cachedClient);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(r.display);
      } catch {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Waykeep: --');
      }
      return;
    }

    // Owner-control routes: dispatched before hook routing and before
    // the generic body read — the RPC enforces its own pre-buffer
    // Content-Length gate and streaming cap.
    if (req.url?.startsWith('/owner/')) {
      await ownerRpc.handle(req, res);
      return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        pid: process.pid,
        uptime: Math.floor((Date.now() - startupTime) / 1000),
        mode,
        routes: Object.keys(routes),
        contract_revision: CONTRACT_REVISION,
      }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      res.writeHead(400);
      res.end(`Bad request: ${err}`);
      return;
    }

    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    // Daemon transport path: client identity arrives as a relay-set header
    // (the direct-node fallback path normalizes in readStdinJson instead).
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const headerClient = req.headers[CLIENT_HEADER];
      normalizeHookInput(
        input as Record<string, unknown>,
        typeof headerClient === 'string' ? headerClient : undefined,
      );
    }

    const route = routes[req.url ?? ''];
    if (!route) {
      res.writeHead(404);
      res.end(`Unknown route: ${req.url}`);
      return;
    }

    try {
      // Handlers may be sync or async — await either. The `as never` cast
      // is the one sanctioned erasure point for unvalidated hook bodies.
      const result = await route.handler(input as never, cachedClient);
      const eventType = route.extractEventType(input as never, result);
      const meta = route.extractMeta?.(input as never, result);
      recordTelemetry(route.telemetryName, eventType, startTime, true, undefined, meta, client.db);

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(result.output ?? '');
    } catch (err) {
      console.error(`[waykeep] Hook handler error on ${req.url}:`, err);
      recordTelemetry('daemon', req.url ?? 'unknown', startTime, false, String(err), undefined, client.db);
      res.writeHead(500);
      res.end(`Handler error: ${err}`);
    }
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error('[waykeep] Unhandled hook request error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal error');
      }
    });
  });
  // The dedicated apply connection lives and dies with the socket owner
  // (Codex advisory): a lingering second connection would keep WAL
  // participation and file descriptors across in-process restarts.
  server.once('close', () => ownerRpc.close());

  // Bind, then fail-closed self-verify BEFORE returning the server as live, so
  // a caller that receives a non-null server can trust it is listening AND
  // proven owner-only.
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => { server.off('listening', onListening); reject(err); };
      const onListening = (): void => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.listen(socketPath(), onListening);
    });
  } catch (err) {
    console.error(`[waykeep] Hook socket bind failed on ${socketPath()}: ${err}`);
    releaseSocketClaim();
    return null;
  }

  // The socket has no request auth; tighten it to owner-only, then PROVE it. A
  // silently-ignored chmod (some network mounts) would otherwise leave the
  // socket connectable by other local users — refuse to serve and fall back to
  // direct-node hooks rather than expose it. The 0700 parent dir is the primary
  // guard; this is the verified defense in depth on the socket file itself.
  try { chmodSync(socketPath(), FS_PERMS.FILE); } catch { /* best-effort */ }
  if (!isOwnerOnly(socketPath())) {
    console.error(
      `[waykeep] Refusing to serve hook socket: ${socketPath()} is not owner-only after bind — using direct-node fallback`,
    );
    // Drop any connection opened in the pre-verify window so close() can't
    // stall on a held-open keep-alive socket (Node >= 18.2; engines require 20).
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    releaseSocketClaim();
    return null;
  }

  // Refresh the claim written by acquireSocketClaim — diagnostic identity for
  // probes and for the claim protocol's mid-startup back-off.
  writeFileSync(pidPath(), String(process.pid), { mode: FS_PERMS.FILE });
  console.error(`[waykeep] Hook socket listening on ${socketPath()} (${mode}, PID ${process.pid})`);

  // Now that we are actually serving, start the tracker flush timer. Deferred
  // to here so the bind-failure / not-owner-only bail-outs above never leave a
  // periodic timer running on a cache we returned null for.
  cache.startPeriodicFlush((tracker, sessionId) => {
    saveTracker(tracker, sessionId);
  });

  // Persistent guard for post-listen socket errors (e.g. an accept-level EMFILE):
  // without a listener the EventEmitter would throw and crash the process. Log
  // and keep running — the direct-node hook fallback covers a degraded socket.
  server.on('error', (err) => {
    console.error(`[waykeep] Hook socket runtime error on ${socketPath()}:`, err);
  });

  // Cleanup on process exit — one shared listener; repeated startHookSocket
  // calls register their cleanup here instead of stacking exit listeners.
  exitCleanups.add(() => {
    cache.destroy(); // Flush dirty trackers to disk
    releaseSocketClaim(); // PID-guarded: never deletes a successor's claim
  });
  if (!exitListenerInstalled) {
    exitListenerInstalled = true;
    process.on('exit', () => { for (const fn of exitCleanups) fn(); });
  }

  return server;
}

const exitCleanups = new Set<() => void>();
let exitListenerInstalled = false;
