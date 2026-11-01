# HD menus

Status: incremental implementation; browser acceptance and remaining coverage belong in the private session report.
Scope: main menu, match options, quit confirmation, skirmish setup and choose-map; native and emulator routes.
The original game remains the sole input owner. The HD layer has no hit areas, input dispatch or game writes.
Layout, animation, state, language and disabled behavior come from the game; only presentation changes.

## Shared presentation contract

The complete target contract identifies route/game/version, surface size, active dialog/root, generation and completeness.
Snapshots and presented pictures share a nonzero generation only when the complete control state was captured with those pixels.
List/combo items, selection, top index, row height, checks and scroll ranges are read from the original controls;
custom slider geometry, color swatches and popups require the corresponding verified game policy.
Each visible control supplies stable id, parent, class/kind, z-order, absolute game-pixel rectangle and clip.
State includes visible/enabled, focused, pressed/captured, hovered, checked and default-action flags.
Text includes the actual Unicode string, alignment, wrap, accelerator, font size/baseline and color.
Raw CSF keys may be resolved through the same installed game's CSF; never ship translated label guesses.
Lists require every item string, count, selection, top index, row height, visible rows and scrollbar range.
Combos also need dropped popup geometry/state; sliders need min/max/value, thumb/groove rectangles.
Edits additionally need text, caret, selection and composition; score screens need ordered rows and animation state.
Unknown, missing and truncated fields are distinct; none may silently become an empty value.

## Native and emulator sources

Native: `packages/native-host/agent/input.c` publishes dialog controls with hidden logical visibility preserved.
`src/vm86/menuSnapshot.ts` owns the route-neutral DTO; adapter native/core and Worker transport carry it.
All control queries share one 10 ms allowance per snapshot and stop after the first timeout.
The GUI owner samples before and after the complete hidden paint. Only identical complete state receives
a generation; intermediate or incomplete paint retains a generation-zero original picture.
The version-validated native YR policy reads actual Unicode labels and owner-drawn item records synchronously.
The transport returns this captured tree, never labels reread after its picture. Old agents without identity keep original menus.
Emulator: `src/vm86/shim/user32Windowing.ts` snapshots the original shim windows, controls and state.
The synchronous game reader enriches that tree at picture capture. Each WM_PAINT/WM_DRAWITEM callback
is tracked by its actual owner slot; identity requires its return and identical complete state before/after painting
and at picture capture. An outer modal callback may remain active, but later private text or control changes
invalidate that stable state until a real repaint finishes. Unfinished paints and visible invalidations retain original pictures.
Choose-map lists use YR's private top index because the subclass handles scrolling without updating the underlying shim index.
The final synchronous scrollbar paint can complete a picture only when it matches an already completed guest paint;
empty default-control painting cannot certify new private text.
`src/games/yr/menuText.ts` reads the verified YR HWND text table; `src/games/yr/hdMenus.ts` recognizes complete screens.
The YR presentation policy treats the 16-bit, signed and unsigned 32-bit `IDC_STATIC` label IDs alike;
the captured IDs and all actionable control IDs retain their original values.
`src/ui/pages/game/hdMenus.ts` draws the picture-only DPR canvas; `page.ts` owns its disposal and switch.
Generic control transport stays in adapter/shim; shared picture/text composition stays in presentation code.
Ordinary battle probes return null without control enumeration, text reads or menu drawing; dispose timers/bitmaps on exit.
Passive pointer observation may schedule visuals; it must not consume events or alter native focus/capture.
Native position-only input may overlap snapshot reads. Clicks, keys and wheel input remain barriers;
an input revision also rejects snapshots whose text read overlaps an already acknowledged activation.
Without an activation, a transient incomplete read may retain the last complete snapshot only while the
actually displayed picture still has the same generation. Frame presentation hides a mismatched layer
synchronously; polling cannot leave stale text over a newer picture. Battle frames carry no menu generation.

## Art and text production

Extract only from the supplied install using `GameInstall`, `rasterizeUiFrame` and `writeUiStrip`.
Existing source tooling: `packages/ra2-assets/src/cli/extractControls.mts` and `src/node/ui.ts` in that package.
Reuse the private ui3 `scripts/remaster/ui3/prepare.py` / `pack.py` workflow for source-bound redraw and packing.
Keep source hashes, palette bindings, prompts, genuine tool output and reviewed crops outside Git.
This session has the built-in image tool: redraw metal/glass/enamel detail at 2x, preserving source silhouettes.
A resampled original is a reference/fallback, never evidence of added HD detail; retain failed candidates.
Main shell: original 800x600 layout, right 156x42 controls, transparent original-animation opening.
Match art: original `BKGDLG` 856x736 and `SIDEBTTN` 125x25; preserve faction source and palette.
Pregame art uses the supplied `MnScrnLCoopGameSetup` and `MnScrnLCustomizeBattle` pictures,
with the original right and bottom shell pieces. Optional `setup` and `chooseMap` manifest entries
provide clean 800x600 background art and button states. The whole original map preview, faction flags and live main-menu gauge
remain visible through exact control-sized apertures; their imagery is not claimed as redrawn.
Other verified families: `BKGDSM` 472x448, `BKGDMD` 632x568, Yuri variants and `PUDLGBG` popups.
Render labels/list entries/numbers as sharp page text at output DPR using original text rectangles.
An optional `fontMetrics` JSON asset supplies the installed font's UTF-16 advances and ink boxes.
Its optional `outlines` map contains prebuilt closed SVG paths in each glyph's ink-local coordinates.
Source contours are traced and smoothed once when producing the private asset, then cached as page paths;
the frame renderer does no tracing or bitmap enlargement. An outlines-equipped font with a missing visible glyph
retains the whole original screen, rather than mixing different faces. Validate source stroke positions and ink area
for each produced glyph; device-resolution browser crops remain necessary to establish sharpness.
Latin letters and digits use their small bold ink; CJK text uses its full-height ink, in the same line box.
Punctuation keeps its measured advance rather than acquiring a host font's full-width cell.
An unknown glyph rejects the complete screen; verified missing glyphs are distinct from unknown entries.
The optional `toneRegions` manifest entries apply measured RGB gains to asset-pixel rectangles once at load.
Compare each calibrated region against its source, including hue and clipping; the mean brightness must stay within 1%.
Retained source shell pieces and previews remain original elements and are not claimed as redrawn art.
The optional `controlSkin: "vector-v1"` selects source-shaped page paths for combo arrows and frames,
list scrollbars and checkbox lamps. Other manifests retain complete original skins.
Sliders and disabled action buttons retain their whole original control while their source tones remain unverified.
The verified YR NewEdit player-name field supplies its live string, caret, first visible character, game-owned blink
and original caret color. The page draws that caret-only editor without its own blink timer or input handling.
The native bridge sends characters once: a control claiming all keys bypasses dialog key translation,
while ordinary dialog navigation keeps its existing route.
Missing metadata, an unknown editor or active IME composition retains the complete original name field.
Keep decorative logos as sourced artwork; never bake dynamic captions or guessed Chinese text into images.
Native animation and original art not yet redrawn remain explicitly identified limitations.

## Atomic fallback and validation

Validate the whole active screen signature, all visible controls, required text/state and loaded artwork first.
Unknown screen/control, missing theme/art/text, unverified custom metadata or incomplete enumeration hides the whole layer.
A matching generation is mandatory even for an otherwise recognized screen; zero/absent/mismatch always shows the whole original.
Never cover only understood buttons while an unknown popup or list remains underneath.
Activating pointer releases, Escape, focused-button Space and default-button Enter hide the layer immediately.
A changed complete dialog tree may restore it on the next poll; an unchanged tree requires two consecutive
fresh snapshots, allowing no-op buttons to recover while rejecting the first responsive pre-swap tree.
This input stabilization is supplementary: the shared capture generation remains the authority for every displayed picture.
Preserve existing HD/original switching; no overlay may survive after its dialog closes or session stops.
Compare original and HD at 1:1 in the owner's wide fullscreen frame at DPR 1.5; record the actual display and viewport.
Inspect every button/state and highest-risk child route, including real list-end scrolling and checkbox toggles.
Measure unchanged native hit positions, animation, menu response and same-scene game speed on current code.
Source/build checks do not establish real-browser acceptance; unobserved routes/states remain UNVERIFIED.

## Remaining screens and required data

| Order | Screen or popup family                                                            | Additional data/art needed                                                                 |
| ----- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | Main menu; match options; quit/return confirmation                                | Complete id signature, game labels, focus/pressed/disabled, faction art and return paths   |
| 2     | Single player; campaign faction/mission; briefing/restate/restart; movies/credits | Descriptions, unlocked/disabled state, list selection, animation/scroll ownership          |
| 3     | Skirmish setup; player/country/color/team/AI dropdowns                            | All rows and popup items, selected values, observers, disabled slots, map preview          |
| 4     | Choose map/game type; random generation; map save/load/delete and result notices  | Full 104/104/25 source lists, wheel/top index, preview/description, edits/sliders/progress |
| 5     | Game controls; sound; display/mode confirmation and restore; keyboard             | Toggles/sliders and live values, all command/key lists, key-capture/conflict dialogs       |
| 6     | Save/load/delete; overwrite/delete/load confirmations                             | Actual filenames, dates, selections, edit/caret, enabled actions and error messages        |
| 7     | Diplomacy/alliances; chat/beacon input; player details                            | Native player names/colors, alliance checks, observers, text edit/composition              |
| 8     | Abort/defeat/victory; score/statistics; campaign results                          | Genuine outcome, headings/names/portraits, native row numbers and animated reveal          |
| 9     | IPX; Internet login/account/friends/matching/ranking/map transfer; rooms/players  | Connected state, credentials fields, complete lists, transfer progress, readiness/errors   |
| 10    | Pause/wait/reconnect/disconnect; load/error/confirmation boxes                    | Full message/button text, progress and modal stack; unusual/mod screens stay original      |

Inventory covers known stock families and source-string candidates; resource IDs and reachability are not yet exhaustively mapped.
Estimate: 1–2 sessions for the first three screens and full states; 2–3 for setup/lists; 2–3 for settings/files.
Allow 2–3 more for score/network/rare popups and both-route regression: about 7–11 sessions total, not a promise.
