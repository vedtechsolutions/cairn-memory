/**
 * Goal + meta-message extraction: distinguishes genuine human task goals
 * from session-management noise (compaction blurbs, resume prose, stop
 * notices) and distills raw user messages into goal statements.
 */
import { type RawEntry } from './snapshot.js';
import { truncateAscii } from '../../../utils/text.js';
import { TRUNCATE } from '../../../constants/budgets.js';

/**
 * Filter out system-generated messages that masquerade as user entries.
 * Returns true only for genuine human-authored text.
 */
export function isHumanMessage(text: string): boolean {
  const trimmed = text.trim();
  // XML tags injected by system (task notifications, system reminders, etc.)
  if (trimmed.startsWith('<task-notification') || trimmed.startsWith('<system-reminder')
    || trimmed.startsWith('<system>') || trimmed.startsWith('<command-name>')
    || trimmed.startsWith('<command-message>')
    || trimmed.startsWith('<local-command-')) return false;
  // Pure XML content (opens with < and closes with >)
  if (trimmed.startsWith('<') && trimmed.endsWith('>') && !trimmed.includes(' ')) return false;
  // Continuation summaries injected by Claude Code on context overflow
  if (trimmed.startsWith('This session is being continued from a previous conversation')) return false;
  // Skill expansion content injected after slash command invocations
  if (trimmed.startsWith('Base directory for this skill:')) return false;
  return true;
}

/**
 * Detect meta-goals: messages about compaction, continuation, or short acks
 * that aren't real task descriptions.
 */
export function isMetaGoal(goal: string): boolean {
  const lower = goal.toLowerCase().trim();
  if (lower.length < 25) return true; // too short to be a real goal

  // Synthetic interrupt/stop/wait notices — Claude Code injects these as
  // user-role messages when the user hits Esc, cancels a run, or stops a
  // slash-command session. They bypass the XML-tag filter in isHumanMessage
  // because they're plain text, but they're third-person session-state
  // descriptions directed at the assistant, not real task goals.
  const stopNoticePatterns = [
    /^the user (stopped|interrupted|cancelled|canceled|halted|aborted|paused)\b/,
    /^\[?request interrupted\b/,
    /^\[?interrupted by (the )?user\b/,
    /\bdo not respond\b/,
    /\bdon'?t respond\b/,
    /\bwait for (the |your |a )?(user'?s?|next|another|further)\b[^.]*\b(message|prompt|input|turn|instruction|response|reply)\b/,
    /\bstop(ped)?\s+(the\s+)?(ultraplan|session|run|turn|conversation)\s+above\b/,
    /\bstop(ped)?\s+(the\s+)?(ultraplan|session|run|turn)\b.*\b(above|previous|prior)\b/,
  ];
  if (stopNoticePatterns.some(p => p.test(lower))) return true;

  // Always-meta patterns: these topics are inherently about session management
  const alwaysMetaPatterns = [
    /\bcompact(ion)?\b/,
    /\btell me the analysis\b/,
    /\bgive me\b.*\banalysis\b/,
    /\bstart\b.*\bwhere\b.*\bleft off\b/,
    // Session exit/return — "let me exit and come back", "i'm going to leave", "i am back now"
    /\b(exit|leave|quit)\b.*\b(come back|return|later)\b/,
    /\blet me (exit|leave|go)\b/,
    /\bi('m| am) (going to )?(exit|leave|go\b(?! ahead))/,
    /\b(come|coming|came) back\b/,
    /\bi('m| am) back\b/,
    // SNR/briefing meta-analysis — about Waykeep itself, not a task
    /\bsnr\b.*\b(analysis|ratio|score)\b/,
    /\bsnr\b.*\b(to|at least|above|over|up to)\b.*\d/,  // "bring SNR to 95%" — metric targets
    /\b(bring|get|raise|push)\b.*\bsnr\b/,               // "bring up our SNR" in any form
    /\bforce\b.*\bcompaction\b/,
  ];
  if (alwaysMetaPatterns.some(p => p.test(lower))) return true;

  // Vague completion directives — no specific task, just "finish/fix everything"
  // These are meta because they don't describe what to do, only that something should be done.
  const vagueCompletionPatterns = [
    /^(just\s+)?(complete|finish|fix|wrap up)\s+(the\s+)?(task|everything|all|it)\b/,
    /\bfix\s+all\s+(the\s+)?(issue|problem|bug|error)s?\b/,
    /\bjust\s+(do|finish|complete)\s+it\b/,
  ];
  if (vagueCompletionPatterns.some(p => p.test(lower))) return true;

  // Long-form resume-session prose: the user's "continue from where we left
  // off" narrative after a compaction or disconnect. These messages can be
  // >60 chars (Claude Code sometimes injects the full prior-goal summary as
  // the resume prompt), so the shortMetaPatterns gate below won't catch
  // them. The patterns target structural phrases that only appear in
  // resume prose, never in real task goals.
  //
  // Example we observed in a compaction_snapshot.initial_goal row:
  //   "Continue this was where you were before we cot disconnected: Next:
  //    Commit 2 — always-on guards ... Ready to proceed?"
  // Every token past "cairn/hooks/shared/briefing/compiler" leaked into
  // queryFp.module until this filter was added.
  //
  // "Resume point:" / "next: …" prose: observed in a live kind=goal memory
  // (id 4ab27ef4…) written via waykeep_learn in a past session — content was
  // "Resume point: uncommitted 4 SNR fixes … Next: re-run snr-probe … then
  // commit". This shape is distinctive enough to reject at the filter (it
  // only appears in session-continuity blurbs, never in real task goals)
  // and catching it here prevents future ingests via any path that runs
  // isMetaGoal (precompact, session-end, briefing render, and the
  // prompt-handler goal-staleness helper added in v3.1).
  const resumeProsePatterns = [
    /\bthis (is|was)\s+where\s+you\s+(were|left\s+off)\b/,
    /\bwhere\s+you\s+left\s+off\b.*\b(before|when|and)\b/,
    /\bbefore\s+we\s+(got|cot|were)\s+disconnected\b/,
    /\bready\s+to\s+proceed\??\s*$/,
    /^resume point:\s/,
  ];
  if (resumeProsePatterns.some(p => p.test(lower))) return true;

  // Short-only meta patterns: common verbs like "proceed" and "continue" are meta
  // ONLY when the message is short (<60 chars). Long messages like "proceed with t4
  // and do not commit until I tell you..." are real task instructions, not meta.
  const SHORT_META_THRESHOLD = 60;
  if (lower.length < SHORT_META_THRESHOLD) {
    const shortMetaPatterns = [
      /\bcontinue\b/,
      /\bproceed\b/,
      /\bgo ahead\b/,
      /\byes\b.*\bplease\b/,
      /\blooks? good\b/,
    ];
    if (shortMetaPatterns.some(p => p.test(lower))) return true;
  }

  return false;
}

/** Strip filler prefixes from a raw user message to produce a distilled goal.
 *  "we need to get to at least 95%" → "get to at least 95%"
 *  "lets just complete the task" → "Complete the task" */
export function distillGoal(raw: string): string {
  const FILLER_PREFIX = /^(we need to|let'?s start|let us start|please|i want to|i need to|we should|let'?s|can you|i want you to|we have to|just|so|ok|yeah|right|now|ple)\s+/i;
  let goal = raw
    .replace(/\bso\s+ple(?:ase)?\b/i, '')  // "so ple" / "so please" mid-sentence (before prefix loop)
    .trim();
  // Strip filler prefixes iteratively (handles chained: "let's just so please...")
  for (let i = 0; i < 4 && FILLER_PREFIX.test(goal); i++) {
    goal = goal.replace(FILLER_PREFIX, '');
  }
  goal = goal
    .replace(/\.\.\.*$/g, '')
    .trim();

  // Capitalize first letter
  if (goal.length > 0) {
    goal = goal[0].toUpperCase() + goal.slice(1);
  }

  return goal.slice(0, TRUNCATE.INITIAL_GOAL_CHARS);
}

/** Mine the original session goal from head-of-file lines — the fallback
 *  used when the tail has no substantial user messages (fresh transcripts). */
export function mineInitialGoalFromHead(headLines: string[]): string | null {
  for (const line of headLines) {
    if (!line.includes('"user"')) continue;
    let entry: RawEntry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user') continue;
    const content = entry.message?.content;
    const texts: string[] = [];
    if (typeof content === 'string' && content.trim()) texts.push(content.trim());
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) texts.push(block.text.trim());
      }
    }
    for (const t of texts) {
      if (t.length > 20 && isHumanMessage(t) && !isMetaGoal(t)) {
        return truncateAscii(t, TRUNCATE.INITIAL_GOAL_CHARS);
      }
    }
  }
  return null;
}
