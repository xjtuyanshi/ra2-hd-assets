import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url),
  cp = require('node:child_process'),
  net = require('node:net');
const spawn = cp.spawn;
cp.spawn = function (...args) {
  const c = spawn(...args);
  console.log('[phase8 trace] spawn ' + args[0] + ' pid=' + c.pid);
  c.once('exit', (code, signal) => console.log('[phase8 trace] exit ' + args[0] + ' ' + code + '/' + signal));
  return c;
};
const cs = net.createServer;
net.createServer = function (...args) {
  const s = cs(...args);
  s.once('listening', () => console.log('[phase8 trace] listen ' + JSON.stringify(s.address())));
  s.once('close', () => console.log('[phase8 trace] listener closed'));
  s.on('connection', () => s.getConnections((e, n) => console.log('[phase8 trace] incoming reserved socket ' + n)));
  return s;
};
syncBuiltinESMExports();
const { runLauncher } = await import('./play-native.mjs');
await runLauncher(process.argv.slice(2));
