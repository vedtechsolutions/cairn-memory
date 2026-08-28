/**
 * Canary for the handshake-era MCP v1 SDK contract.
 *
 * Cairn intentionally remains on the initialize-handshake protocol until the
 * separately designed MCP 2026-07-28 migration is ready. A dependency update
 * must not silently advertise the modern stateless protocol.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';

const HANDSHAKE_ERA_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

describe('MCP SDK protocol-version canary', () => {
  it('remains handshake-era and does not claim MCP 2026-07-28 support', () => {
    assert.equal(LATEST_PROTOCOL_VERSION, '2025-11-25');
    assert.ok(
      SUPPORTED_PROTOCOL_VERSIONS.some(version => HANDSHAKE_ERA_VERSIONS.includes(version)),
      'SDK must retain at least one initialize-handshake protocol version',
    );
    assert.ok(
      !SUPPORTED_PROTOCOL_VERSIONS.includes('2026-07-28'),
      'SDK v1 must not advertise the stateless MCP 2026-07-28 protocol',
    );
  });
});
