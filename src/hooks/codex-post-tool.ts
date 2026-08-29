#!/usr/bin/env node
/** DEPRECATED alias of the post-tool entry — kept for wired installs
 *  whose trusted hook commands (and older relays) exec this filename. */
import { runPostToolEntry } from './shared/post-tool-entry.js';

await runPostToolEntry('codex-post-tool');
