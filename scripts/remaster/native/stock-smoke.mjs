#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentClient } from './wire.mjs';
import { outputDirectory } from './artifacts.mjs';

// Run only for an explicitly unconfigured game launch. Other runner actions
// supply its visible menus, native screenshot and external frame-rate evidence.
const client = new AgentClient(
  'ws://127.0.0.1:15450',
  process.env.RA2_NATIVE_AGENT_TOKEN,
  process.env.RA2_NATIVE_AGENT_ORIGIN,
);
client.on('failure', () => {});
let timer;
const result = { agentListenerAbsent: false, error: null };
try {
  await Promise.race([
    client.connect(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Agent absence check timed out')), 5000);
    }),
  ]);
  throw new Error('An unconfigured game unexpectedly exposes the agent');
} catch (e) {
  result.agentListenerAbsent = e.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(e.message);
  result.error = e.message;
  if (!result.agentListenerAbsent) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  client.close();
  writeFileSync(resolve(outputDirectory(), 'run', 'stock-agent-absence.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
