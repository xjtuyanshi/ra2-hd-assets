import { parentPort, workerData } from 'node:worker_threads';
import WebSocket from 'ws';

// Substitute only browser transport construction, retaining the production native composition.
globalThis.WebSocket = class extends WebSocket {
  constructor(url) {
    super(url, { origin: workerData.origin });
  }
};
const { installVmWorker, NativeMessageType, readPageCombatDiagnostic } = await import(workerData.bundle);
const scope = {
  onmessage: null,
  postMessage(message, transfer = []) {
    parentPort.postMessage(message, transfer);
  },
};
const controller = installVmWorker(scope);
const trace = {
  requests: {},
  renderCalls: [],
  readerCpu: [],
  mirrors: { complete: 0, incomplete: 0, invalid: 0, truncated: 0 },
};
const createCore = controller.dependencies.createCore;
controller.dependencies.createCore = async (...args) => {
  const core = await createCore(...args);
  const createPolicy = core.createPolicy;
  core.createPolicy = (...args) => {
    const policy = createPolicy(...args);
    for (const name of ['createRenderReader', 'createCommandReader', 'createFrameReader']) {
      const factory = policy[name];
      const record = (kind, at) => {
        if (trace.readerCpu.length < 30000)
          trace.readerCpu.push({ name, kind, at, frame: core.memory.frame, ms: performance.now() - at });
      };
      policy[name] = () => {
        const at = performance.now();
        let reader;
        try {
          reader = factory();
        } finally {
          record('factory', at);
        }
        if (!reader) return reader;
        return (...args) => {
          const at = performance.now();
          try {
            return reader(...args);
          } finally {
            record('decode', at);
          }
        };
      };
    }
    return policy;
  };
  const request = core.connection.request.bind(core.connection);
  core.connection.request = async (type, payload) => {
    const at = performance.now(),
      entry = (trace.requests[type] ??= { count: 0, totalMs: 0, maxMs: 0 });
    entry.count++;
    if (type === NativeMessageType.Credit && trace.firstCreditAt === undefined) trace.firstCreditAt = at;
    try {
      return await request(type, payload);
    } finally {
      const elapsed = performance.now() - at;
      entry.totalMs += elapsed;
      entry.maxMs = Math.max(entry.maxMs, elapsed);
    }
  };
  const read = core.getRenderState.bind(core);
  core.getRenderState = async () => {
    const at = performance.now();
    try {
      return await read();
    } finally {
      if (trace.renderCalls.length < 30000)
        trace.renderCalls.push({
          at,
          ms: performance.now() - at,
          frame: core.render.previous?.frame,
          mirrorFrame: core.memory.frame,
          misses: core.memory.misses,
          error: core.render.error,
        });
    }
  };
  core.connection.onMirror((update) => {
    trace.mirrors[update.flags & 5 ? 'incomplete' : 'complete']++;
    if (update.flags & 4) trace.mirrors.invalid++;
    if (update.flags & 1) trace.mirrors.truncated++;
  });
  return core;
};
parentPort.on('message', async (message) => {
  if (message.type !== 'harness-observe') {
    scope.onmessage?.({ data: message });
    return;
  }
  // Observation never enters the controller queue or writes the native game.
  // Its counter is sampled after the render reply was delivered to the page client.
  const core = controller.core;
  try {
    let value;
    if (message.op === 'read') value = await core.connection.read(message.address, message.length);
    else if (message.op === 'input') {
      const reply = await core.connection.request(NativeMessageType.InputState);
      value = JSON.parse(new TextDecoder().decode(reply));
    } else if (message.op === 'hello') value = core.hello;
    else if (message.op === 'combat')
      value = readPageCombatDiagnostic(core.memory.snapshot().accessor(), core.render.previous);
    else
      value = {
        trace,
        mirrorFrame: core.memory.frame,
        misses: core.memory.misses,
        readerErrors: { render: core.render.error, command: core.command.error, performance: core.frame.error },
        stateReadMs: core.stateReadMs,
        stateReads: core.stateReads,
      };
    parentPort.postMessage({ type: 'harness-observed', id: message.id, value });
  } catch (error) {
    parentPort.postMessage({ type: 'harness-observed', id: message.id, error: String(error.stack || error) });
  }
});
