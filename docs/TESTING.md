# Testing guide

Tests are divided into asset-free acceptance and real-game regressions. The former runs in a clean checkout; the latter requires hash-validated game files supplied by maintainers/developers. Missing resources, skips, timeouts, and crashes are never passes.

## Basic acceptance

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
```

`check` includes TypeScript, unit tests, synthetic PE/real v86 instruction tests, architecture checks, and the production build. It explicitly selects `tests/basic/`, `packages/relay/tests/`, `packages/ra2-formats/`, `packages/ra2-assets/` and `packages/hd-renderer/tests/` without reading local executables or implicitly downloading games. `pnpm test` includes all local cases, real-game regressions among them: a missing executable fails the run instead of skipping, so every developer needs the game resources to run the full suite. No test may remove itself from the report. Asset-free download tests also use Node/TypeScript. package.json and lockfiles define dependency/command versions.

Formatting uses the Prettier version pinned in package.json. `pnpm run format` maintains source, tests, scripts, configuration, and documentation. `.prettierignore` excludes original third-party text, resources, and generated lockfiles. Unsupported languages such as Python/assembly are not checked by Prettier.

All tests prohibit `.only`. After editing boot.asm, run `pnpm run build:boot` and synchronize boot.bin; CI assembles again and checks for differences. This command requires `nasm` outside pnpm dependencies. CI installs it explicitly, using `apt-get install -y nasm` on Ubuntu. If unavailable locally, firmware rebuilding cannot run; this does not justify changing boot.bin or bypassing the `firmware-diff` check. Patches check both executable hashes and instruction signatures. Public tests use offline fixtures; real-game regressions rerun the same contracts against original executables. Synthetic fixtures do not replace compatibility validation.

## Test directories

Classify by required resources, not whether filenames contain “game”:

| Directory                                            | Level and resource requirements                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tests/basic/`                                       | Asset-free unit/integration tests, including synthetic game-policy and resource-contract fixtures               |
| `tests/basic/architecture/`                          | Module dependency acceptance                                                                                    |
| `tests/basic/vm/`                                    | Synthetic PE and real v86 instruction regressions without original executables                                  |
| `tests/basic/browser/`, `tests/basic/smoke/`         | Asset-free browser and standalone protocol smoke tests; browsers use Playwright                                 |
| `packages/relay/tests/`                              | Relay-owned asset-free tests included in Basic                                                                  |
| `packages/hd-renderer/tests/`                        | Asset-free renderer math, buffers and LiveView integration included in Basic; no GPU or live-match claim        |
| `packages/ra2-formats/`, `packages/ra2-assets/`      | Synthetic format/asset tests included in Basic; real-install integration files excluded by Vitest configuration |
| `tests/real-game/ra2/`, `tests/real-game/yr/`        | VM regressions requiring each game's original executable/resources                                              |
| `tests/real-game/browser/`, `tests/real-game/smoke/` | Real-game browser, download, and startup smoke tests                                                            |
| `tests/experimental/browser/`                        | External-model experimental regressions excluded from public Basic                                              |
| `tests/helpers/`, `tests/fixture/`                   | Shared helpers/synthetic fixtures, not independent test entries                                                 |

`pnpm run test:e2e` executes real-game VM files serially. CI additionally orders jobs so YR follows completed RA2 acceptance. Basic includes formatting, `check`, firmware consistency, and asset-free browser regressions; see [CI configuration](REAL_GAME_CI.md) for standalone entry points.

HD renderer binding budgets are covered by `packages/hd-renderer/tests/vertexBuffers.test.ts`. It builds real
three.js r186 node shaders and feeds their attributes to the WebGPU backend's vertex-layout builder without
initializing a device. It checks the eight-buffer limit, the sixteen-attribute limit and each uniform binding's
byte length at allocated capacities (including zero visible instances). The 64 KiB matrix boundary is 1024
instances; r186's fallback uses four interleaved columns sharing **one** vertex buffer. The suite also tests
a smaller uniform limit so it cannot silently assume the matrix always fits. Sprite and effect card batches
use plain `Mesh.count` with no instance matrix; grown cell, overlay and smudge pages keep the same binding count.
Other fixtures cover procedural effects/beams, emitters, light fields, rain/splashes, data-sized night poles,
terrain/cliffs/water/reflections, voxel units/projectiles/debris/shadows, sandbox objects/windows and custom
full-screen mist/tone mapping. These are shader-layout checks,
not WebGPU pipeline validation, rendered-pixel acceptance or performance measurements.

Current asset-enabled CI requires original-executable startup, the RA2 quick-game and RA2/YR save/cold-load regressions, and Worker/main-thread direct battlefield startup. Same-host two-client network tests remain manual and are excluded from CI until Chromium cleanup and runner memory capacity are confirmed. Select other real-game cases according to changes. Gonghui requires separate MOD resources; cache restoration requires original packages. Neither is implicitly covered by Basic.

## Select regressions by change

| Change                               | Additional verification                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and interaction                   | test:browser:react-ui; test:browser:touch-ui for touch                                                                                              |
| Localization                         | i18n unit tests and test:browser:react-ui in English/Chinese, including unsupported-language fallback                                               |
| Drawing/upscaling                    | test:graphics and relevant upscale, ai, gan entries                                                                                                 |
| Providers, archives, caches          | test:custom-maps, test:browser:archive-layers; cache-reload for real packages                                                                       |
| ABI, file shims, patches, scheduling | Corresponding asset-free VM tests and affected games' original-executable regressions                                                               |
| Startup entry points                 | test:browser:startup-page, test:browser:battle-start                                                                                                |
| Generic relay                        | Relay package check, test:browser:relay; two-client network tests for game adaptation                                                               |
| Performance                          | Before/after comparisons with identical browser, map, resources, speed, player count, and load                                                      |
| Performance diagnostics              | test:browser:performance; test:browser:battle-start for both games and execution modes; probe/RPC/cancellation unit tests                           |
| CI downloads                         | tests/basic/ciResourceDownload.test.ts, tests/basic/ciGameArchive.test.ts, tests/basic/gameCiResources.test.ts, tests/basic/ciConfiguration.test.ts |

Fixed-address/instruction evidence lives in game modules and their tests. Never widen architecture allowlists, modify clocks, fabricate acknowledgments, or skip defeat checks to pass tests. Preserve failure reasons; a successful rerun does not erase earlier failures.

`tests/basic/shimDplayEnumeration.test.ts` covers nested enumeration storage, out-of-order completion, thread exit, and failed allocation/bridge generation. `tests/basic/vm/dplayEnumeration.e2e.test.ts` executes nested and hardware-preempted callbacks in real v86, including another thread exiting inside its callback. It checks descriptor stability, stack balance, and heap reclamation. `threadRecycle.e2e.test.ts` runs more thread lifetimes than the slot limit and executes x87 instructions after reuse; `displayEnumeration.e2e.test.ts` checks repeated stdcall/cdecl callbacks without growing heap or dynamic code, plus descriptor stability across nested display-mode changes. `tests/basic/guestCodeAllocation.test.ts` also checks variable-size callback scratch boundaries. `tests/basic/shimHeapPressure.test.ts` checks failed object/data/back-buffer allocations and rollback. `tests/basic/shimKernelFileTime.test.ts` checks field independence, invalid dates, leap years, signed capacities, quoted literals, and DBCS trail-byte collisions. All run under `check`; they do not replace original-executable or real multiplayer acceptance.

`pnpm run test:browser:audio` runs asset-free Chromium audio lifecycle acceptance against the configured development origin. It observes real Worklet messages through repeated playback/release cycles across separate AudioContexts, verifies bounded active-processor counts, and checks context closure. Basic CI includes it. This finite lifecycle test does not measure browser heap reclamation or establish full-match audio reliability.

## Save and cold-load regression

`pnpm run check` runs the asset-free OLE callback, storage metadata, asynchronous file-open, time conversion, and window-order regressions: `tests/basic/vm/olePersistence.e2e.test.ts`, `tests/basic/shimOleStorage.test.ts`, `tests/basic/vmCore.test.ts`, `tests/basic/shimFile.test.ts`, `tests/basic/shimWindowZOrder.test.ts`, and `tests/basic/shimScrollbarOcclusion.test.ts`. These do not replace the real RA2/YR save/load regressions:

```bash
VM_GAME_DIR=/path/to/ra2 pnpm exec vitest run tests/real-game/ra2/saveLoad.test.ts --maxWorkers=1
VM_GAME_DIR=/path/to/yr pnpm exec vitest run tests/real-game/yr/saveLoad.test.ts --maxWorkers=1
```

On PowerShell, set `$env:VM_GAME_DIR='C:\path\to\ra2'` before running the same `pnpm exec vitest` command. Resources must include the supported RA2 1.006 or YR 1.001 executable; the test validates its hash before reading version-specific simulation state. Nothing is downloaded implicitly, and a missing executable fails collection instead of skipping the suite.

The test starts a skirmish through normal menus, waits for simulation to advance, saves and closes the confirmation, flushes writes, and destroys the VM. Only serialized save bytes are carried into a new file provider and VM, via a temporary file and the production file-provider message port. Loading must restore the saved simulation frame and recreate the persisted native object counts, then advance simulation and accept the pause command. A new empty match, a successful no-op save, or a stalled loading screen is not a pass; observations and counters only assert, and must never seed the new VM or force a successful load. The installation is never modified. Temporary saves are removed even on failure. The test does not cover browser IndexedDB, campaign transitions, all maps, or long-match state.

The resource-enabled RA2 and YR CI entries run this as a required step after boot tests. `check` verifies that the CI entry still references the regression. PR Basic remains asset-free; the trusted dev/main resource job retains its existing secret boundary. Wiring a test into that job is not evidence that the remote job has run successfully.

The RA2 reference-fixup assertion at `0x69fcbd` reports missing or inconsistent object mappings; it is not by itself evidence of missing installation MIX files.

## Asset-free browser tests

```bash
pnpm run test:browser:install
pnpm run dev
# In another terminal, use the origin printed by dev:
RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 pnpm run test:browser:react-ui
RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 pnpm run test:browser:archive-layers
```

Retain Playwright's extraction fix from 1.60.0 onward: older extract-zip can hang after downloading on Node 24.16.0 (Playwright issues 41000/40998; Node.js issue 63487). The lockfile determines browser versions; verify cold installation after upgrades.

Vite dependency prebundling registers JSX, archive Workers, and experimental model entries. New lazy dependencies require cold-cache startup verification; warm caches or reloads must not conceal split React instances. Prebundling does not mean experimental modules load in the browser.

These entries must block executable preloading and require neither .tmp-third-party/ nor game/. Graphics regressions require working Chromium/WebGL2; missing browser/rendering capability fails instead of degrading into a pass. Synthetic map/archive tests do not establish completeness of real packages. Map-package tests also verify session-save restoration and zero-byte enumeration, deliberately aborting a real IndexedDB transaction after a successful write request to confirm rejection and no residual records.

Existing browser scenarios explicitly use Chinese when checking Chinese UI text. The React smoke test covers both languages at three viewport sizes and English fallback for an unsupported language. Locale-specific unit fixtures preserve existing Chinese assertions; `tests/basic/i18n.test.ts` independently checks selection and translation contracts.

Relay protocol vectors, real sockets, backpressure, rate limits, lifecycle, and standalone builds are part of root acceptance:

```bash
pnpm --filter relay-package run check
pnpm run server:relay --host 127.0.0.1 --port 15176
RELAY_PROBE_GRANT=1 RELAY_PROBE_URL=127.0.0.1:15176 pnpm run test:browser:relay
```

Chromium network regressions explicitly grant local-network-access, covering LAN and loopback. Browser checks cover main-thread/real Worker operation, bidirectional forwarding, and departure cleanup; they do not establish behavior when LNA permission is denied. Container changes additionally require a real Docker build, health check, and browser forwarding; parsing configuration cannot replace image acceptance.

## Real-game regressions

Ordinary local resources live in game/ra2/, with exact executables in .tmp-third-party/. Shared RA2/YR directories should be complete; zero-byte placeholders still count as existing files. `pnpm run prepare:third-party -- --from <install dir>` copies executables from your own installation without network access. Real-game CI imports the same original packages as the frontend outside the workspace, verifies whole-package hashes, and prepares fixed executables; see [CI configuration](REAL_GAME_CI.md).

```bash
VM_GAME_DIR=/path/to/ra2 pnpm exec vitest run tests/real-game/ra2 --exclude '**/gonghui.test.ts'
VM_GAME_DIR=/path/to/yr pnpm run test:vm:yr
pnpm run test:browser:battle-start
pnpm run test:browser:network
pnpm run test:browser:network:yr
```

`VM_GAME_DIR` selects resources for Node real-executable tests; browsers receive files from the development resource service. Real-game suites fail when the required executable is absent instead of skipping, with no opt-out switch: `test:e2e`, `test:vm`, `test:vm:ra2`, `test:vm:yr`, and the full `pnpm test` all behave the same, so every developer needs the game resources locally. Assertions must still verify completeness and behavior. Gonghui is an opt-in third-party MOD: it runs only with VM_GONGHUI=1 and fails if expand01.mix is missing; original-game startup cannot replace it. Never mix addresses/resources from different executables.

Two-client tests use native UI for discovery, room creation/joining, map validation, match startup, and deployment commands, reading player/unit state on both clients to confirm synchronization. WS handshakes or lobby screenshots cannot replace actual game operations. Before Linux multi-VM startup, check memory and record OOM state. Logs include host total/available memory and process names/RSS on preflight failure. Renderer crashes fail immediately; diagnostic sampling has timeouts so unavailable screenshots cannot hang the test. Other processes can still contend for a shared host; preflight does not guarantee resource isolation throughout the run.

## Resource import and restoration

```bash
RA2_BROWSER_ZIP=/path/to/game.zip pnpm run test:browser:cache-reload
```

Verify initial selection, actual cache-transaction commit, and the restored game version after refresh. RA2_BROWSER_GAME=yr selects YR; RA2_BROWSER_MAIN_THREAD=1 checks fallback. Cover missing, zero-byte, failed reads, and unknown separately; filtering zero-byte files before declaring restoration successful is invalid.

Incognito storage quota may be smaller than the package. Explicitly set RA2_BROWSER_STORAGE_QUOTA_BYTES=2147483648 to test restoration with sufficient quota, recording that the override took effect. Passing with an override is not a default-environment pass. RA2_BROWSER_FULL_ARCHIVE=1 compares full extraction, but an old-path pass does not establish layered-loading acceptance.

## Multiplayer performance and faults

```bash
RA2_BROWSER_RELAY=ws://127.0.0.1:15176/ra2 RA2_BROWSER_RELAY_DELAY_MS=25 RA2_BROWSER_STABILITY_SECONDS=60 pnpm run test:browser:network
```

The proxy adds 25 ms each direction, or 50 ms RTT per client. This is additional, not final RTT, and differs from relay --delay-ms. Each second the script outputs actual simulation frames, RequestedFPS, windows, and connection state, then sends new commands after observation. RA2_BROWSER_STABILITY_SECONDS supports 10–600 seconds; RA2_BROWSER_PLAYERS supports 2–8. Multiplayer requires sufficient host resources; 8 connections do not establish a complete 8-player match.

tests/basic/vm/lanStartupTiming.e2e.test.ts checks LAN startup-stub settings, registers, flags, stack, and repeated calls. Real two-client checks read initial targets from timing-transitions.json and actual advancement from performance-timeline.json; these are different evidence. See [Game performance](GAME_PERFORMANCE.md) for native command tracing, baseline replacement, and measurement definitions, and [Network reliability](RA2_NETWORK_RELIABILITY.md) for faults/disconnection boundaries.

## CI and delivery evidence

CI is centralized in .github/workflows/quality-check.yml. Basic test combines formatting and all asset-free acceptance; dev/main then run RA2/YR real-game jobs serially. PRs run Basic only. Configure runners, secrets, packages, and isolation according to [CI configuration](REAL_GAME_CI.md); YAML existence does not establish activation.

PRs should report actual commands, versions, results, and unverified scope. Preserve same-scene performance comparisons and identify maps, speeds, and player counts for game tests. Two-player short matches cannot establish reliability for public networks, long matches, mixed-unit combat, or full campaigns.
