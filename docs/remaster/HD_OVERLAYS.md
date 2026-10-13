# HD battlefield overlays

Scope: YR first; preserve the original geometry, color, order, timing and input behavior at device resolution.
This design is not acceptance of a replacement: live pictures and measurements belong in the private session report.
Baseline: the player's YR 1.001, SHA-256 `7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`.
Sources: the supplied executable, [draw-pipeline research](research/tactical-passthrough.md), [command-state research](research/yr-command-state.md), and [HD bridge](HD_BRIDGE.md).
The draw addresses below were checked against the pinned image/disassembly; unresolved leaf boundaries are identified.

## Ownership and route contracts

Keep YR addresses, field interpretation and patch signatures in `src/games/yr`; generic capture/transport in the adapter.
Presentation consumes explicit drawing data, never game addresses. The existing session owns capture buffers and disposal.
Each publication needs match generation, draw generation, surface/viewport/clip, complete element set and native fallback pixels.
Per object include pointer plus UID, kind, native draw visibility, actual draw anchor, clip, selected/hovered state and layer.
Publish strokes, glyphs and sprite-frame bindings with native colors, source dimensions and baselines; do not infer from HD art bounds.
Native route: bounded reads/capture on the game's draw thread, then one matching picture/publication through the existing Worker.
VM routes: the same YR policy reads `GuestMemory`; draw captures must finish at the corresponding original surface presentation.
Main-thread and Worker VM paths share interpretation and fallback. Their current between-slice snapshots are not draw-atomic.
The page draws at CSS size times DPR, preserving engine-pixel coordinates and the existing tactical crop and original/HD switch.
Native input alone owns selection, dragging, placement and commands; the presentation layer has no hit areas or game writes.

## Element map and selective gates

All rows use the route contracts above. Existing object reads supply health, selection, owner and position, not complete draw state.
For unresolved state, capture the actual leaf draw arguments on each route before considering a native gate.

| Element                             | Engine draw site                                                                                                                               | Required per-frame state and read source                                                                                                                                                                              | Exact suppression boundary / fallback                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health bars                         | `DrawHealthBar 0x6F64A0` / vt `+0x44C`; mobile border calls `0x6F68B4`, `0x6F6947`; health ticks `0x6F6A4A`; building pips `0x6F66BA/0x6F675F` | Health `+0x6C`, type Strength `+0xA0`, PixelSelectionBracketDelta `+0x3E0`, actual draw/hover gate, anchor, clip, pip count and rule thresholds at Rules `+0x1700/+0x1708`; shared validated reader plus draw capture | Gate only confirmed bar/border primitives. Do not skip the whole function: it calls passenger/ammo pips at `0x6F682C/0x6F6AB0`. Unknown bar keeps its entire native bar/border.                                |
| Selection brackets                  | `DrawExtras 0x6F5190`; building front branch `0x6F53A8..0x6F5E10`; rear `DrawBehind 0x6F60D0`, helpers `0x6F5EF0/0x6F6030`                     | Selected `+0x83`, type/building bounds and the engine's projected corners; capture computed endpoints and native color/clip, not sprite extents                                                                       | Gate bracket helper calls only for an accepted object/publication; front and rear are one complete replacement. Mobile borders are owned by the health-bar row. Unresolved geometry leaves both native halves. |
| Control-group numbers               | `DrawPips 0x709A90`; group branch `0x70A6FD..0x70A980`; fill `0x70A940`, outline `0x70A951`, text `0x70A97B`                                   | Group `+0x214` maps 0..9 to printed 1..9,0; owner RGB `+0x56F9`; actual text bounds, clip and font flags `0x49`; shared field reader and draw capture                                                                 | Replace the number's background, outline and text together, never all `DrawPips`. Failure retains all three native components.                                                                                 |
| Passenger/ammo/cargo/occupancy pips | `DrawPips 0x709A90` / vt `+0x450`; additional draw virtual `+0x458 = 0x70AA60`                                                                 | Actual pip kind/count/max/frame/spacing/remap and conditional visibility; passengers `+0x114` alone is insufficient. Capture emitted `PIPS/PIPS2/PIPBRD` commands and validate type-specific reads                    | Leaf SHP calls need classification before gating; no whole-method suppression. Keep all native pips until complete per-object support.                                                                         |
| Veterancy                           | `0x70A990` / vt `+0x454`; SHP leaf `0x70AA4F`                                                                                                  | Rank state `+0x150`, selected frame, anchor and native visibility; read verified rank predicates or capture the emitted frame                                                                                         | Gate only this SHP call after source-frame binding is verified; unknown rank/frame stays native.                                                                                                               |
| Drag band                           | `TacticalClass 0x6DA180`; `DrawRectEx` call `0x6DA21E`                                                                                         | Tactical `+0xD90/+0xD94` start, `+0xD98/+0xD9C` end, native active test, inclusive bounds, palette-derived color and ViewBounds                                                                                       | Gate the one rectangle leaf, retaining native drag processing. Missing/torn state keeps the full native rectangle.                                                                                             |
| Placement grid                      | Tactical `0x6D5030`, before/after object passes                                                                                                | Pending type, native cell-validity results, foundation, elevation, exact `PLACE.SHP` frames and clip; draw capture on both routes, not host feasibility recomputation                                                 | Exact leaf sites and their side effects remain unresolved; gate neither pass until both emitted cell sets are complete. Native grid remains whole.                                                             |
| Target/action lines                 | Mobile vt `+0x438 = 0x4DC060`; building `0x459E60`; action timer `0x70D150`, flag `0x843108`                                                   | Native target/destination/focus, displayed endpoints/color/style, visibility timer and planning state; command reader supplies references, draw capture supplies display decisions                                    | Leaf line gates remain unresolved; never suppress order processing or advance the timer from host time. Failed publication retains native lines.                                                               |
| Rally/waypoint routes               | Tactical passes `0x6DAD60/0x6DA9D0`; planning `0x63B0A0/0x63B150/0x63B2F0`                                                                     | Factory Focus `+0x218`, current route nodes/order, marker frame, height, clip and timing; capture emitted paths/markers, not scenario map waypoints                                                                   | Separate route/marker leaf sites are pending. Unreplaced planning tokens and beacons remain native; never blanket-gate these passes.                                                                           |
| Game message text                   | `MessageListClass::Draw 0x5D49A0`, instance `0xA8BC60`                                                                                         | Actual localized UTF-16 lines, native wrap/baseline/font/color, expiration, input/caret distinctions and clip; bounded list/text reads plus draw capture on both routes                                               | Exact text-only leaf boundaries remain pending; exclude message aging/input handling. Incomplete text or unsupported glyphs retain the complete native message.                                                |
| Mission/superweapon timers          | Tactical timer pass `0x6D4B50`                                                                                                                 | Actual displayed strings, ordered visible timers, native colors/blink/positions and clip; read timer state and capture text, never substitute sidebar charge percentages                                              | Text leaf gates remain pending; keep timer updating and outcome processing untouched. Unknown timer/style retains native text.                                                                                 |

## Frame coherence, gates and fallback

Require the pinned hash and every original instruction signature before installation; any mismatch writes nothing.
Reuse the frame-boundary latch and main-thread protection in `tacticalPassthrough.ts` / `shared/guestGates.ts`.
Use separate element/object capabilities; installing a gate is not permission to activate it. Preserve original instructions.
A gate may suppress only the primitive whose complete replacement and original fallback are captured for that draw generation.
Capture current leaf arguments before suppression; reserve one whole element's journal capacity or execute that element natively.
Reset the journal at the existing render latch; freeze and attach it to the corresponding `nh_present` packet, not a later mirror poll.
Retain the native overlay pixels/coverage for that generation alongside the clean replacement plane; choose a complete pair atomically.
If capture, decoding, bounds, art, output surface or generation matching fails, present the native fallback for that element.
If native fallback cannot be reconstructed with correct occlusion, leave its gate disabled and retain the original drawing.
No pixel erasure by guessed rectangle or color: other units, pips, text and building bodies can overlap that rectangle.
Disconnect, switch-to-original, menu entry and disposal close every active gate and discard stale publications before repaint.
The first reader publishes `battlefieldOverlay` with `presentation: 'native'`; it supplies measurements, not a draw-generation or replacement capability.

The native protocol now negotiates an optional atomic Picture trailer through `limits.drawJournal` and Credit bit 0;
see [Native host protocol](NATIVE_HOST.md). `VmFrame.overlayJournal` carries independent match/draw generations,
source dimensions, a complete clean RGB565 plane and ordered explicit drawing commands. `VmFrame.rgb565` retains
the complete native fallback. The Worker transfers the independently owned clean buffer with that same picture;
neither a mirror poll nor an equal logic frame number can authorize a replacement.
`src/graphics/frameOverlayData.ts` validates the whole publication, including every command, before
`src/graphics/frameOverlay.ts` clips and triangulates rectangles or convex polygons at output-device resolution.
The keyed WebGL path draws a validated pair before the independent cursor. Unknown commands, mismatched generations,
incomplete planes and reported WebGL failures retain the whole native picture. Original view and Canvas 2D also retain it.
These generic transport and drawing capabilities do not establish visual or runtime performance acceptance.

The native producer is in `src/games/yr/nativeDrawJournal.c`, explicitly enabled by the development-page option
`native-draw-journal=1`; the ordinary launcher keeps this capture off. It checks the executable and every instruction
signature before installing draw-thread capture: begin/end `0x4F4480/0x4F459D`, mobile border/tick calls
`0x6F68B4/0x6F6947/0x6F6A4A`, and group
fill/outline/text `0x70A940/0x70A951/0x70A97B`. Conservative write fences cover DSurface lock/fill
`0x4BAD80/0x4BB620`, the later callback `0x4F4555`, planning calls `0x6D46EA/0x6D491A` and ore glints
`0x6D7840`; generic DirectDraw writes also invalidate overlapping captures. The real surface transfer at
`0x4F4B7B`, its software-copy call at `0x4BB293` and the foreign software-copy completion at `0x437985`
and the group background's exact color-fill call at `0x4BB7E8` complete the eighteen verified installation sites.
All sites are verified before a thread-suspended patch transaction because the shared DSurface entries can run on
other threads.
The existing `0x4F44A5` latch is unchanged and every original instruction/call still executes. Capture uses mobile
object identity, target surface, actual SHP/frame, native anchor/clip and match/draw generations.

The later sidebar callback is classified only for a bounded, fully validated gadget chain. Fixed virtual tables,
whole-method signatures, `Next`/`DrawAll`/`DrawMe` slots, required null peers and the shape surface's `GetRect`
must agree. A proved empty draw therefore does not invalidate unrelated health marks. Actual shape writes still
reach the destination-lock fence, and any unknown node or method keeps the complete native fallback.

Validated mobile health borders and ticks can supply replacements. Their source shapes define rectangular
edge, inset and tick geometry; actual after-draw RGB565 samples supply the colors. The native game selects health
frames 16/17/18 and their thresholds; the page does not recompute health colors. Shape canvas/crop dimensions,
draw flags and the complete opaque pattern must validate. Before/after snapshots cover
the complete verified leaf, not a guessed erasure rectangle.
The verified border and tick footprints are entirely opaque. Their exact before-draw pixels may contain earlier
native marks: accepted ticks reverse back to their captured border, then the border restores that actual background.
Ordered page primitives cover every restored pixel opaquely, including overlaps, with the same original draw order.
This relies on complete opaque-pattern validation, nearest native-plane sampling and a non-antialiased overlay pass;
it does not authorize transparent shapes or relax subsequent write fences.

The actual `CopyPart` supplies the tactical-to-primary transform. Both rectangles must fit their validated surfaces,
have equal dimensions and contain every accepted leaf. The transfer must successfully complete exactly one observed
copy: either the verified software call or a plain cnc-ddraw `Blt` with only `DDBLT_WAIT`, no effects or scaling,
16-bit surfaces, identical captured source/destination objects, pixels, pitches and rectangles, and no memory alias.
At outer draw completion, the producer freezes the whole primary, including the sidebar, and compares the complete
copied region with an owned tactical-source snapshot taken by one bounded safe read. Row comparisons use that snapshot
without repeating memory-region queries for every scanline. It then reverses accepted leaves at the recorded translation into a separate
clean primary plane; the game framebuffer is never erased or recolored. Every restored region must still match
its captured after-draw pixels. The final trailer also requires equality between the frozen native primary and the
owned pixels used to encode that same Picture. Source and primary lifetime changes or unclassified writes invalidate
the pair.

The existing HD policy may wrap the DSurface copy and group-rectangle/line slots. The producer accepts only the original targets or the
exact 63-byte `GuestGateBuilder` blit template in bridge-owned code/data allocations: complete branch layout,
current thread owner, `GATE` data marker, zero gate depth, expected return stack cleanup and original tail target must match.
This identifies the existing passthrough mechanism without bypassing its branches or changing its behavior.
Unclassified later writes, partial clipping, unsupported shapes, failed reads or capacity exhaustion invalidate
the candidate; a failed tick also discards its border. Every foreign-thread software destination lock at the exact
`0x7BC176` return site registers an active writer, independently of the currently captured surface. The matching
thread/surface writer retires only after the real destination unlock returns at `0x437985`. Draw capture, freeze
and final publication require no active writer and the same writer generation throughout. Any other foreign
DSurface lock or nonempty foreign DirectDraw write closes replacement for the process, independently of current
capture surfaces or client opt-in state after installation. Classified writes invalidate only the affected publication.
The exact verified source-only lock at `0x7BC1BF` remains read-only on either thread.
The atomic Picture trailer carries only clean rows that differ from that same picture's native fallback.
The page presents either the validated clean plane plus every command or the complete native plane.

Control-group markers are a single fill/outline/text transaction. Additional whole-method fingerprints validate
the original rectangle, line and bitmap-font paths. Capture checks the actual digit, owner RGB565 color, clipping,
surface virtual slots and the complete original glyph record; all address arithmetic is bounded before reading.
The precise hardware color-fill call has a pre/post observer. Alternatively, the fingerprinted software fill must
lock its exact black rectangle once, with matching surface and pitch. The single classified fill, four outline
locks and one text lock must all belong to the same transaction. Other writes keep the conservative fallback. After text
returns, every pixel of the complete marker must match the original fill, outline and glyph bits before any
replacement is published. Page rectangles reproduce the outline and glyph row runs; no browser font is substituted.
Unsupported fills, fonts, clipping, failed reads or interrupted transactions retain the whole native marker.
Building marks and passenger/ammo pips retain their complete native pixels. The existing HD scene still supplies
building bodies; this does not establish whole-building native fallback or correct rear-corner occlusion.
`DIAGNOSTICS.drawJournal` reports readiness, capture/rejection/invalidation counts,
paired pictures and source/present mismatches. Conservative invalidation can leave only a subset of otherwise
supported bars eligible in a given draw. Disconnect closes capture, leaving inert observers and their executable
storage owned until process exit. Live screenshots and measurements must establish actual coverage and fidelity.

## Building occlusion and fidelity

The original rear brackets run before the building body; front brackets and numbers run in the native extras order.
Preserve this with a rear pass in the HD scene and a front overlay pass, using the same object identity and draw anchor.
Rear strokes must pass behind the actual body/roof coverage, including damage layers, turrets and construction art.
A single canvas above the battlefield cannot meet this; a foundation rectangle is not an acceptable occlusion mask.
Retain original colors, integer rounding, corner lengths and group glyph outlines; sharpen edges without changing proportions.
Health-bar ticks and mobile borders have source SHP geometry; rescaling the native raster alone is not an HD replacement.

## Order, measurement and estimate

1. Finish coherent native capture/fallback and exact bar/bracket/number leaves; then enable the three-element slice: 2–3 sessions.
2. Validate passenger/ammo/cargo/rank variants and source frames: 1–2; drag and placement: 1–2 sessions.
3. Target/rally/planning paths: 1–2; actual messages and timers: 1–2; VM parity and cross-route regression: 1–2 sessions.
   Remaining estimate: 7–13 bounded sessions, conditional on reverse-engineering findings and free live runner time.
   Measure incremental reader CPU per frame for real selections of 1, 20 and 100; report sample count, mean and p95 separately from RPC latency.
   Use a three-minute six-player match with frequent human-like selection for logic/HD rates; compare the same scene with overlays disabled.
   Reference only: session 14 measured 62.29 logic/s and 58.4 HD frames/s; those are not current-code performance evidence.
   Inspect 1:1 original/HD pairs at 1728x1117 points/DPR 2: one unit, twenty mixed objects and a damaged building, plus toggle/fallback.
   Check rear corners, full/partial health, group reassignment, clipping, retained pips and no doubled/missing marks; end with `pnpm run check`.
