#!/usr/bin/env node
/**
 * `cairn` CLI entry point. Dispatches subcommands and preserves the original
 * behavior — a bare `cairn` (or `cairn serve`) starts the MCP server — so the
 * repurposed bin stays backward compatible.
 */

function printHelp(): void {
  console.log(`cairn — memory system for AI coding agents

Usage:
  cairn [serve]     Start the MCP server over stdio (default)
  cairn report      Tokens-saved report (--days=N, default 30)
  cairn import      Migrate memories in (--from codex-memories|memory-md|claude-mem)
  cairn init        Write Cairn's client config (--dry-run to preview,
                    --migrate-routes to modernize deprecated hook routes)
  cairn build-relay Compile the fast C hook relay (optional; needs a C compiler)
  cairn doctor      Run install health checks
  cairn --help      Show this help
`);
}

const command = process.argv[2];

switch (command) {
  case 'report': {
    try {
      const { runReport } = await import('./report.js');
      const daysArg = process.argv.find((a) => a.startsWith('--days='));
      let days: number | undefined;
      if (daysArg) {
        const raw = daysArg.slice(7);
        const parsed = Number(raw);
        // Reject rather than silently reinterpret: '--days=abc' reporting
        // one day (or a huge N reporting nothing) misleads.
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
          console.error(`cairn report: --days must be an integer between 1 and 3650 (got "${raw}")`);
          process.exit(1);
        }
        days = parsed;
      }
      process.exit(await runReport(days));
    } catch (err) {
      console.error(`cairn report: failed — ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case 'import': {
    try {
      const { runImport } = await import('./import.js');
      // Both --name=value and --name value forms (the README documents the
      // space form; accepting only '=' made every documented invocation
      // fail — and worse, silently ignored '--path DIR', importing from
      // the DEFAULT location instead of the named one; review).
      const argv = process.argv.slice(3);
      const values: Record<string, string> = {};
      const flags = new Set<string>();
      const VALUE_ARGS = new Set(['from', 'path', 'project']);
      const BOOL_ARGS = new Set(['dry-run', 'include-notes']);
      let argError: string | null = null;
      for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
          // Positional source form: `cairn import codex-memories`.
          if (i === 0 && !values.from) { values.from = token; continue; }
          argError = `unexpected argument "${token}"`;
          break;
        }
        const eq = token.indexOf('=');
        const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
        if (BOOL_ARGS.has(name)) {
          if (eq !== -1) { argError = `--${name} takes no value`; break; }
          flags.add(name);
        } else if (VALUE_ARGS.has(name)) {
          const value = eq !== -1 ? token.slice(eq + 1) : argv[++i];
          if (value === undefined || value.startsWith('--')) { argError = `--${name} requires a value`; break; }
          // An explicitly EMPTY value means unset for every value flag
          // (--project= previously scoped rows to ''; --path= errored
          // with a blank path in the message).
          if (value !== '') values[name] = value;
        } else {
          argError = `unknown flag --${name}`;
          break;
        }
      }
      if (argError || !values.from) {
        if (argError) console.error(`cairn import: ${argError}`);
        console.error('usage: cairn import --from codex-memories|memory-md|claude-mem [--path P] [--project ID] [--dry-run] [--include-notes]');
        process.exit(1);
      }
      process.exit(runImport({
        from: values.from,
        path: values.path,
        project: values.project ?? null,
        dryRun: flags.has('dry-run'),
        includeNotes: flags.has('include-notes'),
      }));
    } catch (err) {
      console.error(`cairn import: failed — ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case 'init': {
    try {
      const { runInit } = await import('./init.js');
      process.exit(runInit({
        dryRun: process.argv.includes('--dry-run'),
        migrateRoutes: process.argv.includes('--migrate-routes'),
      }));
    } catch (err) {
      console.error(`cairn init: failed to run — ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case 'build-relay': {
    try {
      const { runBuildRelay } = await import('./build-relay.js');
      process.exit(runBuildRelay());
    } catch (err) {
      console.error(`cairn build-relay: failed to run — ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case 'doctor': {
    try {
      const { runDoctor } = await import('./doctor.js');
      process.exit(await runDoctor());
    } catch (err) {
      console.error(`cairn doctor: failed to run — ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case undefined:
  case 'serve': {
    // The server module runs its main() on import.
    await import('../mcp/server.js');
    break;
  }
  case '--help':
  case '-h':
  case 'help': {
    printHelp();
    break;
  }
  default: {
    console.error(`cairn: unknown command "${command}"\n`);
    printHelp();
    process.exit(1);
  }
}
