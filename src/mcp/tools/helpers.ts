/**
 * Shared helpers for MCP tool handlers.
 */
import type { ContextMode } from '../../constants/index.js';

const CRITICAL_RESPONSE = {
  content: [{ type: 'text' as const, text: '[cairn silent — context critical]' }],
};

/** Returns the standard critical-mode response if mode is critical, null otherwise. */
export function isCritical(mode: ContextMode): typeof CRITICAL_RESPONSE | null {
  return mode === 'critical' ? CRITICAL_RESPONSE : null;
}
