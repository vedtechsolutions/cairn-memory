/**
 * Socket ownership — cooperative claim protocol for the shared hook socket.
 *
 * Multiple agent clients (Claude Code, Codex, future MCP consumers) each
 * spawn their own Cairn MCP server process, and a standalone daemon may own
 * the socket permanently. Exactly one process may serve
 * ~/.cairn/hook-daemon.sock at a time; everyone else must LEAVE THE OWNER
 * ALONE and share its socket. The historical failure mode this module
 * exists to prevent: a starting server SIGTERM-ing the live owner via the
 * PID file and stealing the socket, killing the other client's MCP server
 * mid-session.
 *
 * Protocol:
 *   1. Probe the socket with GET /health. A live answer is authoritative —
 *      the responder owns the socket; do not claim, do not signal.
 *   2. No answer → the socket file (if any) is stale. If the PID file names
 *      a live foreign process, it is a claimant mid-startup — back off.
 *   3. Otherwise take the claim by writing our PID with the exclusive `wx`
 *      flag; the filesystem arbitrates concurrent racers.
 *
 * Never signals another process under any circumstances.
 */
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdirSync, chmodSync, lstatSync, statSync } from 'node:fs';
import { get, request } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { FS_PERMS } from '../constants/index.js';

// --- Constants ---

/** Startup-path probe; generous because it runs once per process start. */
const PROBE_TIMEOUT_MS = 250;
/** Fire-and-forget invalidation post; the daemon-side 60s skip-gate TTL is
 *  the backstop for a lost notification. */
const BUMP_TIMEOUT_MS = 1000;

// --- Paths ---

/** Socket/PID locations — honor the CAIRN_DIR override (like edit-tracker /
 *  state-io) and resolve lazily so tests can sandbox them without having to
 *  reorder imports around a module-load-time homedir() capture. */
export function cairnDir(): string {
  return process.env.CAIRN_DIR ?? join(homedir(), '.cairn');
}
export function socketPath(): string {
  return join(cairnDir(), 'hook-daemon.sock');
}
export function pidPath(): string {
  return join(cairnDir(), 'hook-daemon.pid');
}

/**
 * Create the Cairn state directory with owner-only permissions, tightening an
 * already-existing world-readable dir (older installs created it at 0755).
 * Directory containment is the socket's only access control, so this runs
 * before the socket is bound. Best-effort chmod: never crash startup on a
 * filesystem that rejects it (some network mounts, non-POSIX hosts).
 */
export function ensureCairnDirSecure(): string {
  const dir = cairnDir();
  mkdirSync(dir, { recursive: true, mode: FS_PERMS.DIR });
  try { chmodSync(dir, FS_PERMS.DIR); } catch { /* best-effort on exotic FS */ }
  return dir;
}

/**
 * Fail-closed same-uid check: true only when `path` is owned by the current
 * effective uid AND carries no group/other permission bits. This is the proof
 * behind the socket's same-uid guarantee — the 0700 dir + 0600 socket are set,
 * then verified, so a silently-ignored chmod (some network mounts) or a
 * pre-existing wrong-owned dir causes a refusal to serve rather than exposing
 * the socket to other local users.
 *
 * `followSymlink` selects the directory vs. socket policy. The state dir check
 * follows the link (a user may legitimately symlink ~/.cairn to an owner-only
 * target on another disk — that stays valid; a link to a group/other-accessible
 * or foreign-owned target is still refused). The socket-file check does NOT
 * follow: the socket we just bound is a real socket, and a symlink where the
 * socket belongs is suspicious. Returns false when the path cannot be stat'd
 * (missing/unreadable → treated as insecure). On non-POSIX hosts, where
 * `process.geteuid` is undefined and unix-socket permissions are not the access
 * boundary, this is not enforceable and returns true.
 */
export function isOwnerOnly(path: string, opts?: { followSymlink?: boolean }): boolean {
  if (typeof process.geteuid !== 'function') return true;
  const euid = process.geteuid();
  try {
    const st = opts?.followSymlink ? statSync(path) : lstatSync(path);
    return st.uid === euid && (st.mode & FS_PERMS.GROUP_OTHER_BITS) === 0;
  } catch {
    return false;
  }
}

// --- Claim protocol ---

export interface SocketProbeResult {
  /** PID reported by the live owner's /health payload (0 when unparseable). */
  pid: number;
}

export type SocketClaim =
  | { claimed: true }
  | { claimed: false; ownerPid: number | null };

/**
 * Ask whoever serves the hook socket to identify itself.
 * Resolves null when the socket file is absent, refuses connections, times
 * out, or answers anything other than a healthy JSON payload.
 */
export function probeHookSocket(): Promise<SocketProbeResult | null> {
  if (!existsSync(socketPath())) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = get(
      { socketPath: socketPath(), path: '/health', timeout: PROBE_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const health = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              status?: string;
              pid?: number;
            };
            if (res.statusCode === 200 && health.status === 'ok') {
              resolve({ pid: Number(health.pid) || 0 });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function readPidFile(): number | null {
  try {
    const pid = parseInt(readFileSync(pidPath(), 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to become the hook-socket owner. Resolves `{claimed: true}` when this
 * process may bind the socket, otherwise the live owner's PID (null when the
 * owner is only known via a lost `wx` race).
 */
export async function acquireSocketClaim(): Promise<SocketClaim> {
  const live = await probeHookSocket();
  if (live) return { claimed: false, ownerPid: live.pid };

  // The socket is dead or absent. A PID file naming a live foreign process
  // means a claimant is mid-startup (PID is written before listen) — back
  // off rather than fight it. A hung owner also lands here; hooks then use
  // their direct-node fallback until it dies, which is strictly better than
  // killing a process we cannot prove is stuck.
  const stalePid = readPidFile();
  if (stalePid !== null && stalePid !== process.pid && isProcessAlive(stalePid)) {
    return { claimed: false, ownerPid: stalePid };
  }

  try { unlinkSync(socketPath()); } catch { /* absent */ }
  try { unlinkSync(pidPath()); } catch { /* absent */ }
  try {
    writeFileSync(pidPath(), String(process.pid), { flag: 'wx', mode: FS_PERMS.FILE });
  } catch {
    // Lost the exclusive-create race to a concurrent claimant.
    return { claimed: false, ownerPid: readPidFile() };
  }
  return { claimed: true };
}

/**
 * Release a claim on process exit. Guarded on PID-file content so a
 * shutting-down former owner can never delete a successor's claim.
 */
export function releaseSocketClaim(): void {
  if (readPidFile() !== process.pid) return;
  try { unlinkSync(socketPath()); } catch { /* absent */ }
  try { unlinkSync(pidPath()); } catch { /* absent */ }
}

// --- Cross-process cache invalidation ---

/**
 * Relay a memory-version bump to the socket owner. Used by MCP servers that
 * did NOT claim the socket: their write tools (cairn_learn, cairn_correct,
 * ...) must invalidate the owner's skip-gate cache or corrections could sit
 * behind cached hook output for up to the 60s TTL. Fire-and-forget by
 * design — the TTL is the backstop when the post is lost.
 */
export function postMemoryBumpToOwner(): void {
  const req = request(
    { socketPath: socketPath(), path: '/bump-memory-version', method: 'POST', timeout: BUMP_TIMEOUT_MS },
    (res) => { res.resume(); },
  );
  req.on('timeout', () => req.destroy());
  req.on('error', () => { /* owner gone; TTL backstop applies */ });
  req.end('{}');
}
