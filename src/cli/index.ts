#!/usr/bin/env node
/**
 * `waykeep` CLI entry point (also installed as `cairn` — the pre-rebrand bin
 * name, kept so existing wiring and muscle memory survive). Dispatches
 * subcommands and preserves the original behavior — a bare invocation (or
 * `serve`) starts the MCP server — so the repurposed bin stays backward
 * compatible.
 */

function printHelp(): void {
  console.log(`waykeep — memory system for AI coding agents (formerly cairn; both bins work)

Usage:
  waykeep [serve]          Start the MCP server over stdio (default)
  waykeep report           Tokens-saved report (--days=N, default 30)
  waykeep import           Migrate memories in (--from codex-memories|memory-md|claude-mem)
  waykeep pack             Manual repo-pack (export|import --dir P [--project ID | --global])
  waykeep migrate-project  Move rows from an old project id to the current one
                           (after a git remote rename; --dry-run to preview)
  waykeep init             Write the client config (--dry-run to preview,
                           --migrate-routes to modernize deprecated hook routes,
                           --statusline-only when hooks+MCP come from the plugin)
  waykeep build-relay      Compile the fast C hook relay (optional; needs a C compiler)
  waykeep locate           Print install locations (JSON; "locate hook-dir" prints that path bare)
  waykeep doctor           Run install health checks
  waykeep --version        Print the installed version
  waykeep --help           Show this help
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
          console.error(`waykeep report: --days must be an integer between 1 and 3650 (got "${raw}")`);
          process.exit(1);
        }
        days = parsed;
      }
      process.exit(await runReport(days));
    } catch (err) {
      console.error(`waykeep report: failed — ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case 'pack': {
    void (async () => {
      const { runPack } = await import('./pack.js');
      // Strict parsing (Codex pack #7): a missing flag VALUE previously
      // consumed the next flag ('--dir --project p' created a directory
      // named '--project' and exited 0). Values may not be flag-shaped;
      // unknown flags, duplicates, extra positionals, and
      // --project+--global are refused before any filesystem or DB work.
      const packArgs = process.argv.slice(3);
      const sub = packArgs[0];
      const opts: { dir?: string; project?: string; global?: boolean } = {};
      let argError: string | null = null;
      for (let i = 1; i < packArgs.length && !argError; i++) {
        const a = packArgs[i];
        if (a === '--dir' || a === '--project') {
          const key = a.slice(2) as 'dir' | 'project';
          const v = packArgs[i + 1];
          if (v === undefined || v.startsWith('-')) argError = `${a} requires a value (got ${v ?? 'nothing'})`;
          else if (opts[key] !== undefined) argError = `duplicate ${a}`;
          else { opts[key] = v; i++; }
        } else if (a === '--global') {
          if (opts.global) argError = 'duplicate --global';
          else opts.global = true;
        } else {
          argError = `unknown argument ${a}`;
        }
      }
      if (!argError && opts.project !== undefined && opts.global) argError = '--project and --global are mutually exclusive';
      if (argError) {
        console.error(`waykeep pack: ${argError}`);
        console.error('usage: waykeep pack export|import --dir <path> [--project ID | --global]');
        process.exitCode = 1;
        return;
      }
      process.exitCode = runPack({ command: sub ?? '', ...opts });
    })();
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
          // Positional source form: `waykeep import codex-memories`.
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
          if (value === '') {
            // Empty means UNSET only for --project (an optional scope).
            // An empty --path/--from means the user MEANT to name a
            // source and failed (unset shell variable in a script) — a
            // silent fall-through to the DEFAULT source imports content
            // they never pointed at, under a success banner (review).
            if (name !== 'project') { argError = `--${name} requires a non-empty value`; break; }
          } else {
            values[name] = value;
          }
        } else {
          argError = `unknown flag --${name}`;
          break;
        }
      }
      if (argError || !values.from) {
        if (argError) console.error(`waykeep import: ${argError}`);
        console.error('usage: waykeep import --from codex-memories|memory-md|claude-mem [--path P] [--project ID] [--dry-run] [--include-notes]');
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
      console.error(`waykeep import: failed — ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case 'migrate-project': {
    try {
      const { runMigrateProject } = await import('./migrate-project.js');
      const args = process.argv.slice(3);
      const dryRun = args.includes('--dry-run');
      const positional = args.filter((a) => !a.startsWith('--'));
      const unknown = args.find((a) => a.startsWith('--') && a !== '--dry-run');
      if (unknown || positional.length !== 1) {
        if (unknown) console.error(`migrate-project: unknown flag ${unknown}`);
        console.error('usage: waykeep migrate-project <old-project-id> [--dry-run]');
        process.exit(1);
      }
      process.exit(runMigrateProject({ oldId: positional[0], dryRun }));
    } catch (err) {
      console.error(`migrate-project: failed — ${(err as Error).message}`);
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
        statuslineOnly: process.argv.includes('--statusline-only'),
      }));
    } catch (err) {
      console.error(`waykeep init: failed to run — ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case 'locate': {
    // Machine-readable install locations. The thin-plugin launcher uses
    // `locate hook-dir` when the `cairn` bin is an executable SHIM
    // (Volta, pnpm shim scripts) rather than a symlink chain — the CLI
    // is the one thing that always knows where it lives.
    const { fileURLToPath: toPath } = await import('node:url');
    const { dirname: dirOf, join: joinPath } = await import('node:path');
    const { realpathSync } = await import('node:fs');
    // realpath the module location: under --preserve-symlinks-main,
    // import.meta.url keeps the symlinked path and the derived root
    // points nowhere (review).
    const packageRoot = joinPath(dirOf(realpathSync(toPath(import.meta.url))), '..', '..', '..');
    const locations = {
      packageRoot,
      hookDir: joinPath(packageRoot, 'dist', 'src', 'hooks'),
      server: joinPath(packageRoot, 'dist', 'src', 'mcp', 'server.js'),
    };
    const which = process.argv[3];
    if (which === undefined) console.log(JSON.stringify(locations, null, 2));
    else if (which === 'hook-dir') console.log(locations.hookDir);
    else if (which === 'package-root') console.log(locations.packageRoot);
    else { console.error(`waykeep locate: unknown location "${which}" (expected hook-dir | package-root)`); process.exit(1); }
    break;
  }
  case 'build-relay': {
    try {
      const { runBuildRelay } = await import('./build-relay.js');
      process.exit(runBuildRelay());
    } catch (err) {
      console.error(`waykeep build-relay: failed to run — ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case 'doctor': {
    try {
      const { runDoctor } = await import('./doctor.js');
      process.exit(await runDoctor());
    } catch (err) {
      console.error(`waykeep doctor: failed to run — ${(err as Error).message}`);
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
  case '--version':
  case '-v': {
    const { VERSION: v } = await import('../constants/index.js');
    console.log(v);
    break;
  }
  case '--help':
  case '-h':
  case 'help': {
    printHelp();
    break;
  }
  default: {
    console.error(`waykeep: unknown command "${command}"\n`);
    printHelp();
    process.exit(1);
  }
}
