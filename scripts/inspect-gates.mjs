#!/usr/bin/env node

import {
  InspectorError, InspectorValidationError, inspectGates, renderInspectorText,
} from '../dist/src/governance/inspector.js';
import { GateConfigError } from '../dist/src/governance/gate-config.js';

function usage() {
  return 'Usage: node scripts/inspect-gates.mjs [--project <root>] [--paths <csv>] [--db <path> | --no-db] [--json]';
}

function parseArguments(argv) {
  let projectRoot = process.cwd();
  let paths = [];
  let dbPath;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
    } else if (argument === '--no-db') {
      if (dbPath !== undefined) throw new InspectorError('--db and --no-db are mutually exclusive');
      dbPath = null;
    } else if (argument === '--project' || argument === '--paths' || argument === '--db') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new InspectorError(`${argument} requires a value`);
      index += 1;
      if (argument === '--project') projectRoot = value;
      if (argument === '--paths') paths = value === '' ? [] : value.split(',');
      if (argument === '--db') {
        if (dbPath === null) throw new InspectorError('--db and --no-db are mutually exclusive');
        dbPath = value;
      }
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new InspectorError(`unknown argument: ${argument}`);
    }
  }
  return { projectRoot, paths, dbPath, json };
}

try {
  const parsed = parseArguments(process.argv.slice(2));
  const report = inspectGates({
    projectRoot: parsed.projectRoot,
    paths: parsed.paths,
    dbPath: parsed.dbPath,
    refuseDefaultStore: process.env.CAIRN_INSPECTOR_TEST === '1',
  });
  process.stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : renderInspectorText(report));
  process.exitCode = 0;
} catch (error) {
  if (error instanceof GateConfigError || error instanceof InspectorValidationError) {
    process.stderr.write(`Gate configuration invalid: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Inspector error: ${message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
