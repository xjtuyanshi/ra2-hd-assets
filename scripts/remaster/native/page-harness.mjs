import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Real dedicated thread, controller, NativeCore, RPC client, transfers and presentation ACKs. */
export async function createPageHarness(options, callbacks = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-page-harness-'));
  const bundle = join(directory, 'page.mjs');
  const observers = new Map();
  let worker, vm, restoreGlobals, releasePromise, destroyPromise;
  const releaseResources = () => {
    releasePromise ??= (async () => {
      let failure;
      try {
        await vm?.destroy();
      } catch (error) {
        failure = error;
      }
      try {
        await worker?.terminate();
      } catch (error) {
        failure ??= error;
      }
      for (const pending of observers.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Harness stopped'));
      }
      observers.clear();
      restoreGlobals?.();
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    })();
    return releasePromise;
  };
  try {
    // Use the already-installed tsx compiler dependency, with no added package or download.
    const require = createRequire(import.meta.resolve('tsx'));
    const { build } = require('esbuild');
    await build({
      entryPoints: [fileURLToPath(new URL('./page-worker-entry.ts', import.meta.url))],
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      define: { 'import.meta.env': '{"DEV":true,"PROD":false,"MODE":"development"}' },
      plugins: [
        {
          name: 'unused-vm-assets',
          setup(builder) {
            builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: 'unused-vm-assets' }));
            builder.onLoad({ filter: /.*/, namespace: 'unused-vm-assets' }, () => ({
              contents: 'export default "unused-emulator-asset";',
            }));
          },
        },
      ],
      logLevel: 'warning',
    });
    // WorkerVmClient's native path uses window only for pagehide ownership, and rAF for frame ACK.
    const oldWindow = globalThis.window;
    const oldRaf = globalThis.requestAnimationFrame;
    const oldCancel = globalThis.cancelAnimationFrame;
    restoreGlobals = () => {
      globalThis.window = oldWindow;
      globalThis.requestAnimationFrame = oldRaf;
      globalThis.cancelAnimationFrame = oldCancel;
    };
    globalThis.window = new EventTarget();
    globalThis.window.navigator = { platform: process.platform };
    globalThis.requestAnimationFrame = (callback) =>
      setTimeout(() => callback(performance.now()), 1000 / (options.displayHz ?? 60));
    globalThis.cancelAnimationFrame = clearTimeout;
    const { WorkerVmClient } = await import(pathToFileURL(bundle));
    let nextId = 1;
    const wireCounts = {};
    worker = new Worker(new URL('./page-worker.mjs', import.meta.url), {
      execArgv: [],
      workerData: { bundle: pathToFileURL(bundle).href, origin: options.origin },
    });
    const adapter = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate: () => worker.terminate(),
    };
    worker.on('message', (message) => {
      wireCounts[message.type] = (wireCounts[message.type] || 0) + 1;
      if (message.type === 'harness-observed') {
        const pending = observers.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          observers.delete(message.id);
          message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value);
        }
      } else adapter.onmessage?.({ data: message });
    });
    worker.on('error', (error) => adapter.onerror?.({ message: error.message }));
    vm = new WorkerVmClient(
      callbacks,
      {
        native: { url: options.url, token: options.token },
        provider: { kind: 'native' },
        preferredGameId: 'yr',
        renderPassthrough: true,
        fastFileRead: false,
        clockRate: 0,
        masterVolume: 0,
        traceCalls: false,
      },
      { workerFactory: () => adapter, recycleFrames: true },
    );
    const observe = (op, fields = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          observers.delete(id);
          reject(new Error(`Observation ${op} timed out`));
        }, 10000);
        observers.set(id, { resolve, reject, timer });
        worker.postMessage({ type: 'harness-observe', id, op, ...fields });
      });
    return {
      vm,
      wireCounts,
      observe,
      readBytes: async (address, length) => (await observe('read', { address, length })).bytes,
      getInputState: () => observe('input'),
      hello: () => observe('hello'),
      destroy() {
        destroyPromise ??= (async () => {
          try {
            await vm.stop();
          } finally {
            await releaseResources();
          }
        })();
        return destroyPromise;
      },
    };
  } catch (error) {
    try {
      await releaseResources();
    } catch (cleanupError) {
      if (error instanceof Error) error.cause ??= cleanupError;
    }
    throw error;
  }
}
