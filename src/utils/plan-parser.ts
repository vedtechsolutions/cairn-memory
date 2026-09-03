/**
 * Parse markdown plan content into a structured name + steps format.
 * Used by the plan-bridge hook to auto-persist Claude Code plan mode plans.
 */
import { truncateAscii } from './text.js';
import { TRUNCATE } from '../constants/index.js';


/**
 * Parse markdown plan content into a name and list of steps.
 * Handles common plan formats: numbered lists, bullet lists, checkbox lists.
 * Returns null if the content doesn't look like a plan (fewer than 2 steps).
 */
export function parsePlanContent(content: string): { name: string; steps: string[] } | null {
  const lines = content.split('\n');

  // Extract name from first heading
  let name: string | null = null;
  for (const line of lines) {
    const match = line.match(/^#{1,3}\s+(.+)/);
    if (match) {
      // Strip common plan prefixes
      name = match[1]
        .replace(/^(Implementation\s+)?Plan:\s*/i, '')
        .replace(/^(Architecture|Design|Migration)\s+Plan:\s*/i, '')
        .trim();
      break;
    }
  }

  if (!name) {
    // Fallback: first non-empty line, but reject file metadata and source code
    const firstLine = lines.find(l => l.trim().length > 0);
    if (firstLine) {
      const trimmed = firstLine.trim();
      // Reject encoding declarations, shebangs, source code, and comments
      if (/^(-\*-|#!|\/\/|\/\*|import |export |const |let |var |class |function |<\?|<!DOCTYPE|\{|"use )/i.test(trimmed)) {
        return null;
      }
      name = trimmed;
    }
  }
  if (!name) return null;

  // Extract steps: try numbered list first, then checkboxes, then bullets
  let steps = extractNumberedSteps(lines);
  if (steps.length < 2) steps = extractCheckboxSteps(lines);
  if (steps.length < 2) steps = extractBulletSteps(lines);

  if (steps.length < 2) return null;

  // Truncate
  const truncated = steps.map(s => truncateAscii(s, TRUNCATE.PLAN_STEP_CHARS));
  return { name: name.slice(0, TRUNCATE.PLAN_NAME_CHARS), steps: truncated };
}

/** Extract steps from numbered list items (1. Step description) */
function extractNumberedSteps(lines: string[]): string[] {
  const steps: string[] = [];
  let currentStep = '';

  for (const line of lines) {
    const match = line.match(/^\s*\d+\.\s+(.+)/);
    if (match) {
      if (currentStep) steps.push(currentStep.trim());
      currentStep = match[1];
    } else if (currentStep && /^\s{2,}/.test(line) && line.trim()) {
      // Indented continuation
      currentStep += ' ' + line.trim();
    } else if (currentStep && line.trim() === '') {
      // Empty line — keep collecting
    } else if (currentStep && !/^\s*[-*]\s/.test(line)) {
      // Non-list line ends step collection (sub-bullets are ok)
      steps.push(currentStep.trim());
      currentStep = '';
    }
  }
  if (currentStep) steps.push(currentStep.trim());
  return steps;
}

/** Extract steps from checkbox items (- [ ] Step or - [x] Step) */
function extractCheckboxSteps(lines: string[]): string[] {
  const steps: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+\[[ x]]\s+(.+)/i);
    if (match) steps.push(match[1].trim());
  }
  return steps;
}

/** Extract steps from bullet list items (- Step or * Step) */
function extractBulletSteps(lines: string[]): string[] {
  const steps: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+(.+)/);
    if (match && !line.match(/^\s*[-*]\s+\[/)) { // skip checkboxes
      steps.push(match[1].trim());
    }
  }
  return steps;
}
