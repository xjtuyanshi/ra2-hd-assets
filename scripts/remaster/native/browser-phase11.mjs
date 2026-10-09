#!/usr/bin/env node
// Keep session artifacts separate while exercising the installed Chrome binary.
process.env.NATIVE_BROWSER_PHASE = 'phase11';
process.env.NATIVE_BROWSER_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await import('./browser-phase9.mjs');
