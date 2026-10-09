#!/usr/bin/env node
// Isolate this session's bounded artifacts while using the installed Chrome.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outputDirectory } from './artifacts.mjs';
const scope = JSON.parse(await readFile(join(outputDirectory(), 'phase12/deadline.json'), 'utf8'));
assert(Number.isFinite(Date.parse(scope.deadlineAt)), 'A valid bounded phase12 deadline is required');
process.env.NATIVE_BROWSER_PHASE = 'phase12';
process.env.NATIVE_BROWSER_USE_WINDOW_DIMENSIONS = '1';
process.env.NATIVE_BROWSER_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await import('./browser-phase9.mjs');
