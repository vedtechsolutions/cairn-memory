/**
 * Success pattern classifier — detects learnable success patterns from tool chains.
 * Mirrors error-classifier.ts but for positive outcomes.
 */
import { SUCCESS_DETECTION_WINDOW_MS, LEARNABLE_SUCCESS_PATTERNS } from '../constants/index.js';

export interface ToolEvent {
  tool: string;
  file?: string;
  timestamp: number;
  /** true = verified success, false = failure, undefined = outcome unknown
   *  (Codex demux with no rollout match). Undefined is falsy at every
   *  consumer, so an unknown outcome can never count as a success. */
  success?: boolean;
  output?: string;
}

export interface SuccessClassification {
  learnable: boolean;
  pattern: string;
  tags: string[];
}

export interface SuccessDedup {
  lastPattern: string | null;
  lastTime: number;
}

/**
 * Classify a tool chain for learnable success patterns.
 * Detects: Read → Edit → Bash(pass), Write → Bash(pass), multi-file coordination.
 * Pass dedup state from persistent storage to avoid re-detecting the same pattern.
 */
export function classifySuccess(toolChain: ToolEvent[], dedup?: SuccessDedup): SuccessClassification {
  if (toolChain.length < 2) {
    return { learnable: false, pattern: '', tags: [] };
  }

  // Check if the chain ends with a successful Bash command
  const last = toolChain[toolChain.length - 1];
  if (last.tool !== 'Bash' || !last.success) {
    return { learnable: false, pattern: '', tags: [] };
  }

  // Check if output matches a success pattern
  const output = last.output ?? '';
  const isSuccessOutput = LEARNABLE_SUCCESS_PATTERNS.some(p => p.test(output));
  // Exit code 0 alone is not evidence of verification: without this gate,
  // any `ls`/`echo` after an edit minted a "test pass" success pattern and
  // a "Verified: ... (tests pass)" plan note. Require an explicit success
  // pattern (tests pass, build succeeded, ...) in the command output.
  if (!isSuccessOutput) {
    return { learnable: false, pattern: '', tags: [] };
  }

  // Identify the pattern type
  const editTools = toolChain.filter(t => t.tool === 'Edit' || t.tool === 'Write');
  const readTools = toolChain.filter(t => t.tool === 'Read');
  const files = [...new Set(editTools.map(t => t.file).filter(Boolean))] as string[];

  let pattern: string;
  let tags: string[] = ['success_pattern'];

  if (files.length >= 3) {
    // Multi-file coordination
    pattern = `Multi-file edit (${files.length} files) → test pass`;
    tags.push('multi-file');
  } else if (readTools.length > 0 && editTools.length > 0) {
    // Read → Edit → test pass
    const fileExts = files.map(f => f.split('.').pop()).filter(Boolean);
    pattern = `Read → Edit → test pass for ${fileExts.join(', ')} files`;
    tags.push(...fileExts as string[]);
  } else if (editTools.length > 0) {
    // Edit → test pass (first-try success)
    pattern = `Direct edit → test pass`;
  } else {
    return { learnable: false, pattern: '', tags: [] };
  }

  // Dedup: skip if we've seen this exact pattern within the detection window
  const now = Date.now();
  if (dedup?.lastPattern === pattern && dedup.lastTime && (now - dedup.lastTime) < SUCCESS_DETECTION_WINDOW_MS) {
    return { learnable: false, pattern: '', tags: [] };
  }

  return { learnable: true, pattern, tags };
}
