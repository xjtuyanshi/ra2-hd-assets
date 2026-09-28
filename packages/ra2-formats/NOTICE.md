# Notice

The sources under `src/` are vendored from **Vanguard** (project `harshilmathur/openra2`), commit `8ba59f0`,
directory `packages/formats/src`, licensed GPL-3.0-or-later. Vanguard's loaders are themselves ported from and
verified against the GPLv3 **XCC** library by Olaf van der Spek (MIX, Blowfish/WS key, PAL, SHP(TS), TMP(TS),
VXL/HVA, LCW), with map framing verified against the GPLv3 **FinalSun/FinalAlert 2 Mission Editor** by Matthias
Wagner. Per-file attribution comments from upstream are kept verbatim.

Local modifications (this repository):

- `src/map/isoMapPack.ts`: `decodeBase64` uses a portable pure-TypeScript decoder instead of Node's `Buffer`, so
  the package runs unchanged in browsers.
- `src/index.ts`: header comment renamed for this package.
- `src/mix/mixFile.ts`: dropped an unused private `view` field and marked an unused parameter (`_view`) so the
  sources pass `noUnusedLocals`/`noUnusedParameters` in consumers with those flags; behaviour unchanged.
- `src/vxl/hvaFile.ts` (+ its test): HVA matrices are read frame-major (`(sectionCount * frame + section) * 48`),
  which is how the retail files are laid out (e.g. `ytnktur.hva`: CYL14, CYL22, DUMMY01 for frame 0, then again for
  frame 1) and how XCC, OpenRA and Chrono Divide read them. Upstream read them section-major, which handed every
  section after the first another section's matrix on multi-section, multi-frame files.
- Upstream `*.integration.test.ts` files (which need a real game install) are not vendored; the pure unit tests are
  kept and run in the repository's root vitest suite. Tests may use Node `Buffer`; library code must not.

This package reads the player's own game files at runtime; it contains no game data.
