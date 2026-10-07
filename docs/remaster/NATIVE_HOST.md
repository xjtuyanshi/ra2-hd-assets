# Native host bridge (development only)

The native host runs the player's original 32-bit executable in its own process. A fork of cnc-ddraw supplies the local agent; the existing development page and HD renderer attach to a frame-boundary mirror through the same Worker/shell seam. This is an experimental backend. Offline builds and synthetic tests do not establish the live acceptance gates.

## Build and ownership

Run `bash packages/native-host/build.sh` with the installed i686 MinGW tools. No download or package installation is performed. The ignored output is `packages/native-host/build/ddraw.dll`. Copy it into a dedicated copy of the player's game, retaining the previous DLL for rollback. The vendored MIT source and its exact changes are described in [the vendor README](../../packages/native-host/third_party/cnc-ddraw/README.md); our C implementation lives in `packages/native-host/agent/`.

The agent is disabled without explicit configuration. With no authenticated client, stock drawing, physical input and game pacing remain the owner of the original game. The DLL never changes the game speed on its own. A client may request the game's existing speed setting; smoke tools restore it after measurement.

Configure the copied game's `ddraw.ini`:

```ini
[agent]
enabled=1
port=15450
token=REPLACE_WITH_RANDOM_HEX
origin=http://127.0.0.1:15451
```

Use a random 32–128 digit hexadecimal token, for example `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`. The same values can be supplied through `RA2_NATIVE_AGENT_PORT`, `RA2_NATIVE_AGENT_TOKEN` and `RA2_NATIVE_AGENT_ORIGIN`. Do not publish the token. The server binds only `127.0.0.1`, permits ports 15450–15459, checks the configured Origin exactly, authenticates `/?token=HEX`, and admits one client. Tokenless clients and other origins are rejected. The handshake and incoming WebSocket packets have size/time limits. Fragmented, text, unmasked or malformed application packets are rejected.

## Binary protocol, version 1

One WebSocket carries requests, replies and streaming updates. All application messages are binary and all integers little-endian. The 16-byte header is `magic:u32 = 0x3142484e`, `version:u16 = 1`, `type:u16`, `requestId:u32`, `payloadLength:u32`. Correlated replies preserve request ID and type; errors use type 13 with UTF-8 explanation. Stream messages use ID zero. Client requests and ACK notifications use nonzero IDs. ACK is a notification without a response.

| Type           | Payload / response                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Hello        | UTF-8 JSON: protocol, pid, gameThreadId, exe `{size,peTimestamp,sha256,verified}`, surface `{width,height,bpp,format}`, limits                                      |
| 2 Read         | Request address, length, expectedFrame; reply frame, address, length, bytes. `0xffffffff` means an unconstrained direct read.                                       |
| 3 Write        | Address, length, bytes; empty success. Restores region protection after writing.                                                                                    |
| 4 Alloc        | Size, preferredAddress, executable; reply address, size. Preferred nonzero must be satisfied exactly.                                                               |
| 5 Free         | Agent-owned allocation address; empty success.                                                                                                                      |
| 6 Subscribe    | rangeCount, ruleCount, maxPages, budgetUs, sampleCount; ranges `(address,length)`; rules `(kind,source,bytes,maxCount,stride)`. Replaces the prior subscription.    |
| 7 Mirror       | frame, flags, pageCount, sampleCount; each page address then 4096 bytes; each independent direct sample address, length, bytes                                      |
| 8 Credit       | Exactly one; asks for the next available primary-surface picture.                                                                                                   |
| 9 Picture      | frame, width, height, rowCount; changed rows `(y,encodedLength,segments)`                                                                                           |
| 10 Input       | kind, a, b, c; kind 1 = postMessage, 2 = key state, 3 = cursor position; empty success                                                                              |
| 11 Diagnostics | Empty request; JSON counters including logicFrames, mirrorBytes, hookUs, hookMaxUs, droppedUpdates, truncation, frameHook and gameThreadId                          |
| 12 Hook        | Boolean u32; enable/disable the version-checked frame hook.                                                                                                         |
| 13 Error       | UTF-8 error; never an assumed success                                                                                                                               |
| 14 Input state | Empty request; JSON API-consumption/message-delivery counters, cursor and held keys                                                                                 |
| 15 ACK         | Frame u32 acknowledging the sole in-flight mirror                                                                                                                   |
| 17 Sample      | count, then address/length pairs (up to 16). These direct samples are captured on the logic thread before random samples.                                           |
| 16 Batch       | count; entries address, length, expected original bytes, replacement bytes. All originals must match before any mutation; bounded suspend/patch/rollback operation. |

A pointer follow rule (kind 1) reads the pointer at source and follows a block of `bytes`. A pointer-vector rule (kind 2) reads items at source+4 and count at source+16, mirrors the pointer list and each item's block. A span-vector rule (kind 3) follows a contiguous count×stride span using the same descriptor. Null pointers and empty vectors are valid. Counts, addresses, arithmetic and total pages are bounded; invalid reads become explicit mirror flags or request errors.

Limits are 32 MiB per application message, 4096 mirror pages/ranges, 256 follow rules, 64 samples and a 100–4000 μs configured hook budget. Allocation ownership is bounded separately. The game thread uses nonblocking lock acquisition, preallocated capture buffers and a mailbox swap; only the I/O thread touches the socket. Dirty page generations accumulate until the client ACKs. Slow clients receive the newest complete image after the ACK, including every still-dirty page. A budget overrun is reported, never hidden by clock changes.

Mirror flag 1 means truncated, flag 2 resets the subscription baseline, flag 4 means invalid pages. Clients discard incomplete frame images and retain their previous good reader result. Independent sample bytes are copied directly on the same game thread and logic frame, then compared with the mirror by the smoke tool. An I/O-thread `Read(expectedFrame)` only reports success when the frame counter is unchanged around the read; it is not a frozen full-frame capture.

Picture rows contain u16 segments. Bit 15 selects a run of RGB565 key colour `0xf81f`; bits 0–14 give a nonzero pixel count. Literal runs are followed by that many u16 pixels. A row must decode to exactly the width. The first picture and every size change contain all rows. One credit is outstanding at a time; the agent advances its exact picture baseline only after successful sending.

## Mirror and installer semantics

The adapter owns the socket, sparse pages, request timeouts, frame credits, retry scheduling and destruction. Game policies supply addresses, follow rules, reader factories, speed writes and passthrough installation. YR facts stay under `src/games/yr/`; generic native mechanisms stay under `src/adapter/native/`. No architecture allowlist changes are necessary.

Sparse reads never synthesize zero bytes. `NativeMemoryMiss` subscribes the absent pages. Even if an existing optional reader catches that exception, the operation records the miss, discards the entire result and recreates its reader factories. Reader retries use complete mirror frames; asynchronous direct reads never contaminate the frame image. An installer runs against a private transaction image, buffers every write and restarts the whole operation after fetching absent pages or obtaining allocations. Only a successful complete operation submits an atomic compare-and-write batch. An uncertain commit reply retains executable reservations to avoid dangling jumps.

The logic hook validates the pinned executable identity and its full instruction signature before installing a removable detour at the frame counter store. The detour preserves general registers, flags and x87/SSE state. Frame-counter readers validate the actual native detour metadata instead of pretending the patched bytes remain original. Passthrough uses the existing YR installer with an explicit native thread guard, leaving the v86 guard unchanged. Agent-owned stub/data allocations remain alive until process exit; disconnected clients must not leave entry-site patches enabled or erase storage referenced by an in-flight guest call.

Input is delivered through cnc-ddraw's hooked WinAPI cursor, keyboard and focus facilities and tagged messages to the game WndProc. It does not move the physical cursor. DirectInput is unsupported. API consumption counters distinguish accepted requests from calls consumed by the game. Owned modal-dialog and child-control input routing is not implemented: tagged messages currently reach the original main-window WndProc only. Battle input and virtual focus behavior still require live validation.

## Smoke tools and recordings

Start a six-player XMP26S6 match with five Easy AIs in the dedicated game copy and bottle. Use 150–250 technos for the speed comparison.

```bash
export RA2_NATIVE_AGENT_TOKEN="$TOKEN"
export RA2_NATIVE_AGENT_ORIGIN=http://127.0.0.1:15451
export NATIVE_OUT="$OUT"
node scripts/remaster/native/agent-smoke.mjs --seconds 30 --soak 600 --record-seconds 60 --baseline-log "$OUT/no-client.log"
node scripts/remaster/native/reader-smoke.mjs --seconds 60
```

The first tool checks identity, direct counters, same-frame independent samples, native-picture PNG, input consumption and diagnostics; measures speed 1 and speed 0 with streaming; records inbound packets under `OUT/recordings/`; restores the original speed. Measure the no-client speed-0 baseline separately with the existing external probe in the same scene. Its timestamped log and matching object range must accompany the 85% ratio. The tool cannot establish that two different scenes were comparable. A separate disabled-agent run is required for stock behavior acceptance.

Recordings have `NHREC1\n`, followed by records `(relativeTimeMs:f64,length:u32,rawPacket)`. They contain game-derived memory and frames and must stay outside Git under `gameres/`. Use `reader-smoke.mjs --seconds 60 --record` to capture the full reader subscription. The smaller Stage A recording exercises protocol/frame replay but may require pages it never subscribed. A recording can be replayed through the actual decoder/readers by `reader-smoke.mjs --replay "$OUT/recordings/session.nhrec"`; no private recording is a public test fixture.

## Browser start order

1. Build and install the DLL into the dedicated game copy. Set the agent token and exact HTTP development origin in the copy's `ddraw.ini` or launcher environment.
2. Start the original game through the existing launcher, in the dedicated Wine bottle and virtual desktop, and enter a match. One game at a time.
3. Start the existing development server on port 15451, with `RA2_GAME_ROOT` set to a directory containing `ra2/` linked to the dedicated game copy, and `RA2_HD_CACHE_DIR` set to the owner's existing HD cache. The server reads those assets; do not modify the cache. `RA2_DEV_HTTP=1 pnpm exec vite --host 127.0.0.1 --port 15451 --strictPort` avoids an HTTPS page connecting to an insecure WebSocket.
4. Open the usual YR development page with `backend=native&agent=ws%3A%2F%2F127.0.0.1%3A15450&agent-token=TOKEN&hd=1`. Select the game resources as required by the existing page. The native path attaches to the running process; it does not launch another emulator or native game.
5. On completion stop the page and the dedicated game/bottle using the existing launcher shutdown recipe.

The Worker path is required; native connection errors must not silently start v86. Emulator file attachment/persistence, clock-rate control, memory-change recording, call tracing and browser audio volume have no native implementation: explicit unsupported values/errors are returned. The native game's audio remains in the native process. The lead must validate HD compositing, mouse/cursor alignment, menu overlays, modal dialogs, picture toggling, browser local-network permission and repeated disconnect/reconnect. No native browser or hardware acceptance is implied by an offline check.
