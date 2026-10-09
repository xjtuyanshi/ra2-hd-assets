#!/usr/bin/env node
// Exercise the current page in installed Chrome without touching the owner's profile.
process.env.NATIVE_BROWSER_PHASE = 'phase10';
process.env.NATIVE_BROWSER_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await import('./browser-phase9.mjs');
