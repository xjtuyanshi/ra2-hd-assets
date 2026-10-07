# VM Worker maintenance

## Current implementation

- `src/adapter/runtime.ts` provides the VM creation entry point and main-thread implementation.
- `src/adapter/vmClient.ts` manages the main-thread Worker client; `vmWorker.ts` is the Worker entry point, and `vmWorkerController.ts` owns its lifecycle and message handling.
- `src/adapter/vmCore.ts` runs the guest; `vmProtocol.ts` defines the cross-thread protocol.
- The main thread retains the web UI, presentation, and browser audio while the Worker executes the VM. Startup code determines capability detection and main-thread fallback; browser names must not become hardcoded support guarantees.
- `VmShell.runtimeInfo` records the selected execution mode and probe/fallback evidence. The on-demand `diagnostics` RPC carries start/sample/stop actions through the existing request lifecycle; the shared core reads native counters and the injected platform execution probe. See [Performance reports](GAME_PERFORMANCE.md#browser-comparison-reports).
- File providers are not cloned directly into the Worker. Session resources are accessed on demand through file ports. The executable must be an independent copy of the exact version selected by the page, with no fallback to a different local version.
- `src/app/session/` owns sessions; `src/graphics/` owns presentation scheduling. Do not duplicate the session controller in the Worker layer.

## Emulator settings

- `?jit-modules=expanded` (off by default; main thread and Worker alike) gives the pinned v86 build room for 2019
  compiled modules instead of its own 899: `src/vm86/jitModuleTable.ts` rewrites nine immediates of the binary's
  free-slot list after checking its SHA-256 and every site, and `src/platform/browser/emulator.ts` loads the
  rewritten binary with a function table grown to match, falling back to the stock binary on any failure. v86 never
  evicts a compiled module and throws its whole compiled cache away when a 900th is needed; asset-free tests run a
  guest with 1000 hot code pages in the real emulator both ways. The staged six-player battles measured so far used
  about 300 slots, so the stock table was never full there: the play page's speed telemetry reports modules
  compiled and given up per window (`jitFreed`), which is where a clear in a long match would show.

- Measured with the pinned v86 0.5.441 on YR 1.001 in a six-player battle (CPU profile of the VM worker, staged
  scene of about 500 objects; baseline `51368c7`): three quarters of the guest's time ran in JIT-compiled modules
  and under 1 % in the interpreter, so the hot game routines are compiled; x87 arithmetic, which v86 computes in
  80-bit software floating point, took about 11 % of it, dispatch between compiled modules about 6 %, and no
  memory slow path, page walk or timer callback reached 0.1 %. Larger JIT modules (`set_jit_config`: 12 pages and
  1000 extra basic blocks instead of 3 and 250) changed the guest's instruction rate by less than the run-to-run
  noise in a side-by-side run and are not used. The guest ran about 246 million instructions a second with nothing
  else on the machine and 110 to 160 with one or two more browser sessions next to it: the VM thread is CPU-bound
  and loses directly to other load.

## Maintenance and verification

Protocol changes must update both endpoints, cancellation/destruction, and rejection of pending requests. Fallback must not leave an old Worker behind or run two VMs simultaneously. Transfer frames only through independent buffers; never transfer guest WASM memory.

Run `pnpm run check` and add browser and real-game checks according to [Testing](TESTING.md). `pnpm run test:browser:battle-start` covers direct battlefield startup for RA2/YR in Worker and main-thread modes. File changes also require map import, layered-resource, and real ZIP cache-reload checks. Passing startup regressions does not establish complete browser capability coverage, save restoration, or full-match correctness.

[ARCHITECTURE.md](ARCHITECTURE.md) is the architecture entry point. This guide records Worker implementation, fallback boundaries, and verification entry points.
