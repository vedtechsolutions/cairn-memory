/**
 * Error distillation — converts raw errors into one-sentence pitfall lessons.
 *
 * Two strategies:
 *   1. Regex-based: pattern-matches common error formats (TypeScript, Python, Node, SQLite)
 *      and extracts structured "When X, Y happens. Fix: Z" lessons. Always available.
 *   2. MCP sampling: asks host LLM to distill (capability-gated, Claude Code Issue #1785).
 *      When it ships, this activates automatically as an upgrade over regex.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { neutralizeMemoryText } from './validation.js';

/** Regex-based error distillation patterns.
 *  Each pattern extracts structured components from common error formats. */
const DISTILLATION_PATTERNS: Array<{
  pattern: RegExp;
  distill: (match: RegExpMatchArray, toolName: string) => string;
}> = [
  // TypeScript: "error TS2345: Argument of type 'X' is not assignable to type 'Y'"
  {
    pattern: /error TS(\d+):\s*(.+)/,
    distill: (m, tool) => `${tool}: TS${m[1]} — ${m[2].slice(0, 120)}. Fix: check types match expected signatures.`,
  },
  // TypeScript: "Cannot find module 'X'"
  {
    pattern: /Cannot find module ['"]([^'"]+)['"]/,
    distill: (m, tool) => `${tool}: module '${m[1]}' not found. Fix: check import path and package.json exports.`,
  },
  // TypeScript/JS: "Property 'X' does not exist on type 'Y'"
  {
    pattern: /Property '(\w+)' does not exist on type '([^']+)'/,
    distill: (m, tool) => `${tool}: '${m[1]}' doesn't exist on type '${m[2].slice(0, 60)}'. Fix: check the type definition.`,
  },
  // Node: "ERR_MODULE_NOT_FOUND" or similar
  {
    pattern: /ERR_MODULE_NOT_FOUND.*?'([^']+)'/s,
    distill: (m, tool) => `${tool}: module '${m[1]}' not found. Fix: verify path and file extension (.js for ESM).`,
  },
  // Python traceback: "TypeError: X"
  {
    pattern: /(?:TypeError|ValueError|AttributeError|KeyError|ImportError):\s*(.+)/,
    distill: (m, tool) => `${tool}: ${m[0].slice(0, 150)}. Fix: check argument types and object attributes.`,
  },
  // SQLite: "SQLITE_ERROR: ..."
  {
    pattern: /SQLITE_(ERROR|CONSTRAINT|BUSY):\s*(.+)/,
    distill: (m, tool) => `${tool}: SQLite ${m[1].toLowerCase()} — ${m[2].slice(0, 100)}. Fix: check schema and query syntax.`,
  },
  // Edit tool: old_string not found
  {
    pattern: /old_string.*not found|could not find.*old_string|no match/i,
    distill: (_m, tool) => `${tool}: old_string not found in file. Fix: re-read the file — content may have changed.`,
  },
  // Permission/ENOENT errors
  {
    pattern: /ENOENT.*?'([^']+)'/s,
    distill: (m, tool) => `${tool}: file '${m[1].split('/').pop()}' not found. Fix: verify the path exists.`,
  },
  // Generic exit code failure
  {
    pattern: /exit code: (\d+)/,
    distill: (m, tool) => `${tool}: command failed with exit code ${m[1]}. Fix: check the command output above for details.`,
  },
];

/**
 * Distill a raw error into a one-sentence lesson using regex patterns.
 * Returns a structured lesson, or a truncated first-line fallback. The result
 * is neutralized: error text is attacker-influenceable (a hostile repo can
 * make a build print anything), so the fallback especially must not carry a
 * forged `[CAIRN]` prefix or control characters into stored memory.
 */
export function regexDistillError(toolName: string, rawError: string): string {
  return neutralizeMemoryText(regexDistillErrorRaw(toolName, rawError));
}

function regexDistillErrorRaw(toolName: string, rawError: string): string {
  // Try each pattern in priority order
  for (const { pattern, distill } of DISTILLATION_PATTERNS) {
    const match = rawError.match(pattern);
    if (match) {
      return distill(match, toolName);
    }
  }

  // Fallback: take first meaningful line and format as lesson
  const firstLine = rawError.split('\n').find(l => l.trim().length > 10)?.trim();
  if (firstLine) {
    return `${toolName} error: ${firstLine.slice(0, 150)}`;
  }
  return `${toolName} failed. Fix: re-read the relevant file and try a different approach.`;
}

/**
 * Attempt to distill via MCP sampling, falling back to regex distillation.
 * MCP sampling is capability-gated — currently not supported by Claude Code.
 */
export async function distillError(
  rawError: string,
  toolName: string,
  innerServer: Server | undefined,
): Promise<string> {
  // Always try regex first (fast, no async, no model needed)
  const regexResult = regexDistillError(toolName, rawError);

  // If MCP sampling available, try for a better result
  if (innerServer) {
    try {
      const caps = (innerServer as unknown as { getClientCapabilities?: () => { sampling?: unknown } })
        .getClientCapabilities?.();
      if (!caps?.sampling) return regexResult;
    } catch {
      return regexResult;
    }

    try {
      const result = await innerServer.createMessage({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Distill this error into a one-sentence pitfall lesson. Format: "When X, Y happens because Z. Fix: do W instead."\n\nError:\n${rawError.slice(0, 500)}`,
          },
        }],
        systemPrompt: 'You are a memory distillation engine. Return ONLY the one-sentence lesson. No preamble, no explanation.',
        maxTokens: 150,
        modelPreferences: {
          hints: [{ name: 'haiku' }],
          costPriority: 0.9,
          speedPriority: 0.8,
          intelligencePriority: 0.2,
        },
      });

      const content = result.content;
      if (Array.isArray(content)) {
        const textBlock = content.find((c: { type: string }) => c.type === 'text');
        if (textBlock && 'text' in textBlock) return neutralizeMemoryText((textBlock as { text: string }).text);
      } else if (content && typeof content === 'object' && 'type' in content && content.type === 'text') {
        return neutralizeMemoryText((content as { text: string }).text);
      }
    } catch { /* MCP sampling failed — use regex result */ }
  }

  return regexResult;
}
