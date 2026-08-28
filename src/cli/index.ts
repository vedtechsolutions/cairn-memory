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
      const days = daysArg ? Math.max(1, parseInt(daysArg.slice(7), 10) || 0) : undefined;
      process.exit(await runReport(days));
    } catch (err) {
      console.error(`cairn report: failed — ${(err as Error).message}`);
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
