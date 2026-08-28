#!/usr/bin/env node
/** PostToolUse demux — canonical standalone entry (relay fallback when
 *  the daemon socket is unavailable). */
import { runPostToolEntry } from './shared/post-tool-entry.js';

await runPostToolEntry('post-tool');
