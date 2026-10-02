# Remaster performance harnesses

Measurement-only tools for the remaster plan's performance gate G0 (docs/remaster/PLAN.md). They drive the normal
development page with the player's own YR 1.001 files and never ship with the game.

## g0LateGame.mts

Starts a YR skirmish (or loads a save), lets the AIs build up, and records once per second:

- the native simulation counter through the same reader as `VmShell.getGamePerformance()` (see
  [Game performance](../../../docs/GAME_PERFORMANCE.md)), windowed with `tests/helpers/gamePerformance.ts`;
- the toolbar's presented-frame rate (`#vm-fps`, 500 ms windows);
- read-only native object counts (vehicles, infantry, aircraft, buildings, houses, per-house ownership), self-checked
  against each other so a wrong address shows up as `consistent: false` instead of silently wrong numbers.

At the end it can run the built-in 20-second performance diagnostics capture and save the game through the native
pause menu, so a later run can load the identical scene at another resolution or in another execution mode.

Skirmish setup comes from the game's own `RA2MD.INI` `[Skirmish]` section (`GameMode`, `ScenIndex`, `SlotNN`), which
`?start-page=battle` then starts natively. Keep that INI in a scratch copy of the installation (a directory of
symlinks plus the edited INI), never in the player's installation or in Git. `ScenIndex` indexes the battle map list:
the `[MultiMaps]` entries of `missionsmd.pkt` (index 0 is `XMP29U2`) followed by the maps that loose `.yro`/`.mmx`
packages add through their own embedded `[MultiMaps]`. To start one particular loose map, give the scratch copy a loose
`missionsmd.pkt` containing only an empty `[MultiMaps]` section (loose files take precedence over the MIX copy) and
keep only that map's `.yro` link: `ScenIndex=0` then selects it. Point the development server at the scratch root:

```bash
RA2_GAME_ROOT=/path/to/scratch-root pnpm run dev --host 127.0.0.1   # scratch-root/ra2/ holds the YR files
```

Before every timed window the harness lists other heavy processes (vitest, v86, Chromium, Codex runs) outside its
own process tree and waits up to `G0_CONTENTION_WAIT_S` for a quiet host; every check is stored in the JSON.

| Variable                 | Default            | Meaning                                                                         |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------- |
| `G0_OUT`                 | required           | Output directory (JSON timeline, logs, screenshots)                             |
| `G0_NAME`                | `g0`               | File prefix                                                                     |
| `G0_START`               | `battle`           | `battle` (new skirmish), `load` (load a save), `skirmish` (explore settings)    |
| `VM_BROWSER_MODE`        | `worker`           | `worker` (production default) or `main` (`vm-worker=0`)                         |
| `G0_RESOLUTION`          | INI `[Video]`      | A toolbar preset such as `1920x1080`; empty keeps the INI size                  |
| `G0_UNIT_TARGET`         | 250                | Mobile units (vehicles + infantry + aircraft) that end the build-up             |
| `G0_BUILDUP_MAX_S`       | 1500               | Build-up wall-clock limit                                                       |
| `G0_WARMUP_S`            | 30                 | Warm-up after a load before measuring                                           |
| `G0_MEASURE_S`           | 150                | Measurement window length                                                       |
| `G0_SPEEDS`              | (keep)             | Native speeds 0–6 to measure in turn, set through the in-game speed slider      |
| `G0_SAVE_EVERY_S`        | 0                  | Periodic saves during build-up (fallback checkpoints)                           |
| `G0_SAVE_AT_END`         | 0                  | `1` saves after measuring                                                       |
| `G0_LOAD_INDEX`          | 0                  | Save-list entry to load (0 = first)                                             |
| `G0_PROFILE`             | ephemeral          | Persistent Chromium profile; required for loading a save written by a prior run |
| `G0_VIEWPORT`, `G0_DPR`  | `1512x982`, 2      | Page size and device scale factor                                               |
| `RA2_BROWSER_EXECUTABLE` | Playwright default | Browser binary (use a full Chrome for Testing build for GPU-backed headless)    |
| `G0_DIAGNOSTICS`         | 1                  | `0` skips the 20 s diagnostics capture                                          |
| `G0_CONTENTION_WAIT_S`   | 1800               | Maximum wait for a quiet host before a window                                   |
| `G0_DEBUG`               | 0                  | `1` opens the debug side panel (adds page work; keep off for measurements)      |

Single-player speed targets measured with the native Game Controls slider at light load (YR 1.001): speed 0 is
uncapped (about 80–120 logic FPS early in a match on an Apple M5 Pro), speed 1 holds about 60, speed 2 about 30,
speed 3 about 20 and speed 6 about 10, i.e. 60/N for N ≥ 1. The project's startup default is speed 0.
`G0_EXPLORE_SPEED_CLICKS` (slider fractions), `G0_EXPLORE_OPTIONS=1` and `G0_START=skirmish` with
`G0_EXPLORE_CLICK` are exploration modes that dump native controls and screenshots instead of measuring.

Limits: the local player stays idle, so it can be defeated and end the match; the camera stays where the game puts it;
speed 0 has no fixed target, so its windows measure raw capacity. A headless browser on a desktop is not a phone measurement.
