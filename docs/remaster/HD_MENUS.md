# HD menus

Status: first-slice design; browser acceptance and remaining coverage belong in the private session report.
Scope: main menu, match options and quit confirmation first; native host first, then the emulator route.
The original game remains the sole input owner. The HD layer has no hit areas, input dispatch or game writes.
Layout, animation, state, language and disabled behavior come from the game; only presentation changes.

## Shared presentation contract

The complete target contract identifies route/game/version, surface size, active dialog/root, generation and completeness.
The first slice supplies geometry, text, basic states and completeness; the additional fields below remain pending.
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
Later list/combo/slider messages need bounded game-thread queries; timeout means incomplete.
Button-state queries share one 10 ms allowance per snapshot and stop after the first timeout,
so a busy GUI cannot delay transport input, reads and credits once for every button.
The first slice exports buttons/static text only; complete list/slider/edit publication is remaining work.
Dialog identity is rechecked; atomic frame/dialog generation remains pending for asynchronous transitions.
Emulator: `src/vm86/shim/user32Windowing.ts` snapshots the original shim windows, controls and state.
`src/games/yr/menuText.ts` reads the verified YR HWND text table; `src/games/yr/hdMenus.ts` recognizes complete screens.
`src/ui/pages/game/hdMenus.ts` draws the picture-only DPR canvas; `page.ts` owns its disposal and switch.
Generic control transport stays in adapter/shim; shared picture/text composition stays in presentation code.
Ordinary battle probes return null without control enumeration, text reads or menu drawing; dispose timers/bitmaps on exit.
Passive pointer observation may schedule visuals; it must not consume events or alter native focus/capture.
Native position-only input may overlap snapshot reads. Clicks, keys and wheel input remain barriers;
an input revision also rejects snapshots whose text read overlaps an already acknowledged activation.
Without an activation, an incomplete read of an otherwise identical dialog tree retains the last complete
snapshot and the 80 ms poll cadence. A changed tree, changed root or null still exposes the original picture.

## Art and text production

Extract only from the supplied install using `GameInstall`, `rasterizeUiFrame` and `writeUiStrip`.
Existing source tooling: `packages/ra2-assets/src/cli/extractControls.mts` and `src/node/ui.ts` in that package.
Reuse the private ui3 `scripts/remaster/ui3/prepare.py` / `pack.py` workflow for source-bound redraw and packing.
Keep source hashes, palette bindings, prompts, genuine tool output and reviewed crops outside Git.
This session has the built-in image tool: redraw metal/glass/enamel detail at 2x, preserving source silhouettes.
A resampled original is a reference/fallback, never evidence of added HD detail; retain failed candidates.
Main shell: original 800x600 layout, right 156x42 controls, transparent original-animation opening.
Match art: original `BKGDLG` 856x736 and `SIDEBTTN` 125x25; preserve faction source and palette.
Other verified families: `BKGDSM` 472x448, `BKGDMD` 632x568, Yuri variants and `PUDLGBG` popups.
Render labels/list entries/numbers as sharp page text at output DPR using original text rectangles.
Keep decorative logos as sourced artwork; never bake dynamic captions or guessed Chinese text into images.
Native animation and original art not yet redrawn remain explicitly identified limitations.

## Atomic fallback and validation

Validate the whole active screen signature, all visible controls, required text/state and loaded artwork first.
Unknown screen/control, missing theme/art/text or incomplete enumeration hides the whole layer;
atomic picture/dialog generation pairing remains pending.
Never cover only understood buttons while an unknown popup or list remains underneath.
Activating pointer releases, Escape, focused-button Space and default-button Enter hide the layer immediately.
A changed complete dialog tree may restore it on the next poll; an unchanged tree requires two consecutive
fresh snapshots, allowing no-op buttons to recover while rejecting the first responsive pre-swap tree.
This stabilization does not prove picture identity for a longer posted or animated transition.
Preserve existing HD/original switching; no overlay may survive after its dialog closes or session stops.
Compare original and HD at 1:1 at 1728x1117 points/DPR 2; inspect every button/state and highest-risk child route.
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
