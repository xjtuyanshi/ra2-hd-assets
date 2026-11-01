#!/usr/bin/env node
// Isolate this session's bounded artifacts while using the installed Chrome.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { outputDirectory } from './artifacts.mjs';
const phase = process.argv[3] || 'phase12';
assert(/^phase[0-9]+$/.test(phase), 'A numbered session is required');
const scope = JSON.parse(await readFile(join(outputDirectory(), phase, 'deadline.json'), 'utf8'));
assert(Number.isFinite(Date.parse(scope.deadlineAt)), 'A valid bounded session deadline is required');
// Older parallel runners require tree:<track> first but parse `quiet` only
// before it. Keep the same admission limit here, before importing any launcher.
let quietAdmissionLoad = null;
if (process.argv[8] === 'quiet') {
  const load = loadavg()[0];
  quietAdmissionLoad = load;
  console.log(`quiet admission load1: ${load.toFixed(2)}`);
  if (load >= 12) {
    console.log(`BUSY: machine loaded (load1 ${load.toFixed(1)}, limit 12); nothing was started.`);
    process.exit(3);
  }
}
process.env.NATIVE_BROWSER_PHASE = phase;
process.env.NATIVE_BROWSER_USE_WINDOW_DIMENSIONS = phase === 'phase28' ? '0' : '1';
process.env.NATIVE_BROWSER_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await import('./browser-phase9.mjs');

// Repeat admission at completion because the bounded runner keeps the log tail.
if (quietAdmissionLoad !== null) console.log(`quiet admission load1: ${quietAdmissionLoad.toFixed(2)}`);
