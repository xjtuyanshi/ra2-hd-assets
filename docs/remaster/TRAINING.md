# Practice lessons (training mode)

Development-only practice sessions for the HD page: a prepared scenario plus a coach panel with ordered tasks, each
recognised from the player's real key and mouse input together with the game's live order state. Nothing of it is in
production builds, and nothing it needs from the game is in Git.

## Starting it

```bash
scripts/remaster/play.sh --train          # lesson list; builds the scenarios on first use
scripts/remaster/play.sh --train --print  # only the address
```

The page address carries `train=menu` (lesson list) or `train=<lesson id>` together with `game-root=<scenario>` and
`start-page=battle`; a lesson address starts the development files and the lesson's game without further clicks.
`debug-key=0` gives the backquote key to the game. Restart, next lesson and lesson list are links in the coach panel
(each loads the page again with another address).

## Pieces and where they live

| Piece                | Location                                          | Notes                                                                                    |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Order state contract | `src/games/commandState.ts`                       | selection, control groups, missions and what they point at, newest alert, native sidebar |
| YR 1.001 reader      | `src/games/yr/commandState.ts`                    | hash and instruction-signature guarded; evidence in `research/yr-command-state.md`       |
| VM request           | `VmShell.getCommandState()`                       | Worker and main thread; reader loaded on demand in development builds only               |
| Lesson contract      | `src/games/training.ts`                           | inputs, samples, detectors, tasks, lessons                                               |
| Generic detectors    | `src/games/shared/trainingDetectors.ts`           | object filters, "chord with effect", view tests; no game names                           |
| Lesson engine        | `src/app/training/lessonRun.ts`                   | order of tasks, time per task, hints, summary; pure logic                                |
| YR lessons           | `src/games/yr/training/lessons.ts`                | type names, missions and the projection are YR facts                                     |
| Cheat sheet          | `src/games/hotkeys.ts`, `src/games/yr/hotkeys.ts` | shown by the toolbar's hotkey button; evidence in `research/yr-hotkeys.md`               |
| Session controller   | `src/ui/pages/game/training/trainingSession.ts`   | one interval timer; polls the state, turns forwarded inputs into chords                  |
| Panels               | `src/ui/pages/game/components/TrainingPanels.tsx` | coach panel, lesson list, cheat sheet; inside `#screen-frame`, pointer-transparent       |
| Scenario builder     | `scripts/remaster/training/`                      | `mapkit.py`, `buildScenarios.py`                                                         |

Inputs are observed where the page forwards them to the game (`GameInputOptions.observe`), so a lesson sees exactly
what the game received, with the Apple-keyboard mapping already applied. The observer cannot change or block input,
and the panels never take a pointer event except on their own buttons and links.

## Lessons

A lesson is `{ id, title, summary, scenario, ready?, hotkeys, tasks }`; a task has a title, an instruction, a hint and
a detector. A detector receives the current state, the state when the task became active, every input since then and
a scratch map, and returns true (or 1) when the task is done, or a number below 1 as progress; the hint appears after
20 seconds (or the task's own time) without progress. Rules that keep detection honest:

- A task that teaches a key is built with `chordWithEffect`: the effect without the key, or the key without the
  effect, does not complete it.
- Count by identity (`byUid`) rather than by totals: the scenario also holds objects of the player at the far start.
- Texts are Chinese source strings; add their English to `runtimeMessages.ts` (a test lists what is missing).

`tests/basic/yrTrainingLessons.test.ts` holds a good and a bad synthetic case for every task.

## Scenarios

`buildScenarios.py` writes below `<main checkout>/gameres/s2x/play/train` (outside Git): scratch copies of the
player's own maps with objects and triggers added as text, one game folder of links per scenario, and a cache root of
links to the HD cache (the copy keeps the map's name, so the map's HD art applies). Facts the builder relies on, all
observed in live sessions:

- A skirmish needs a computer opponent; `[Skirmish] SlotNN` first value 4 / 5 / 6 is the brutal / medium / easy one.
- Start positions must be waypoints 0..n-1 without gaps, and the human's start is random. Scenarios are therefore
  symmetric: the same kit stands at both starts and is handed to whoever starts there (Neutral owner, tag, trigger
  "elapsed time, change house"), and the targets at a start go to the other player.
- Objects owned by the map's country houses stop a skirmish from loading; only Neutral objects and the hand-over work.
- With `[Basic] IgnoreGlobalAITriggers=yes` the easy computer player builds a base and stays there; it does use units
  and an MCV handed to it, and attacks buildings of the player next to its base.

## Verification

- `pnpm exec vitest run tests/basic/training*.test.ts tests/basic/yrTrainingLessons.test.ts tests/basic/yrCommandState.test.ts tests/basic/gameInputPlay.test.ts`
- Live: a driver that performs every task through real input events and checks the coach panel after each, plus one
  wrong key per task that must not complete it. It needs the player's files and is not part of the asset-free checks.

Not covered yet: waypoint and patrol practice, timed openings, micro and a full match against the computer.
