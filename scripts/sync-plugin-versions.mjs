#!/usr/bin/env node
// Keep both marketplace plugin manifests in version-lockstep with
// package.json — wired into the npm `version` lifecycle so a release
// bump can never leave them behind (the plugins.test.ts lockstep guard
// is the backstop, this is the automation).
import { readFileSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf-8')).version;

// The MCP serverInfo constant rides the same lockstep — its "keep in
// sync" comment alone drifted to 5.1.0 on a 5.3.1 install (validation).
const constants = 'src/constants/index.ts';
const source = readFileSync(constants, 'utf-8');
const synced = source.replace(/export const VERSION = '[^']+';/, `export const VERSION = '${version}';`);
if (synced !== source) {
  writeFileSync(constants, synced);
  console.log(`${constants} → ${version}`);
}

for (const path of [
  'plugins/claude/cairn/.claude-plugin/plugin.json',
  'plugins/codex/cairn/.codex-plugin/plugin.json',
]) {
  const manifest = JSON.parse(readFileSync(path, 'utf-8'));
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${path} → ${version}`);
}
