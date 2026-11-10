# YR ore and gem glints (TacticalClass 0x6D7840)

Baseline: Yuri's Revenge 1.001 `gamemd.exe` as supplied by the player, read as code and table bytes only. The HD
counterpart is `packages/hd-renderer/src/ra2/cellGlints.ts` (state and timing) and
`packages/hd-renderer/src/live/glintLayer.ts` (drawing); tests are in `packages/hd-renderer/tests/cellGlints.test.ts`.

## Two separate sparkle mechanisms

1. **TWNK1 anims** (`[General] OreTwinkle=TWNK1`, `OreTwinkleChance=30`): created once at map start (0x685052 to
   0x6850E0) on random tiberium cells, looping with `RandomLoopDelay`. These are ordinary anims; the HD effect path
   draws them with their native frames.
2. **The glint pass 0x6D7840**, called last in the tactical render (0x6D492B). It is the field-wide single-pixel
   sparkle and is skipped on the native surface in HD mode (`tactical-passthrough.md`, gate `terrain:ore-glints`).

## The glint pass

- It runs only when the measured frame rate 0xABCD44 is not below the detail threshold from 0x55AF60, on a 16-bit
  surface, and walks the cells in view.
- A cell qualifies when it has tiberium (0x485020 non-zero, kind 1) or water land type (CellClass+0xEC == 2,
  kind 0), CellClass+0x12C bit 0x10 is set, 0x487950 returns false, CellClass+0xE4 is 0 and CellClass+0x140 bit
  0x1000 is clear. The last four conditions are not identified by name.
- Each qualifying cell keeps one 0x3C-byte glint object at CellClass+0xFC, made on first use (0x631E30, which
  restarts it at once). A glint whose phase reached 0x2000 restarts (0x631D40):
  - one `rand()` gives the pixel offset, x = (r & 63) - 31 and y = ((r >> 5) & 31) - 15, from the centre of the
    cell's screen rect (0x47FF80: 60 x 30 at the cell's height; raised by the tile's extra image height when the
    tile has one);
  - the end colour is the table's, minus `randomBits` random bits per channel from one more `rand()`;
  - the phase is set to 0, the rate to `rand() % (rateMax - rateMin + 1) + rateMin` phase units per millisecond
    and the delay to `rand() & delayMask` milliseconds.
- Elapsed time is the `timeGetTime()` delta since the previous pass (0xB0E640), clamped to 1000 ms.
- 0x631EE0 subtracts it from the delay; nothing is drawn while the delay is above 0, and the delay then stays 0.
- When the pixel is inside the view, 0x631E50 adds rate x elapsed to the phase (capped at 0x2000) and sets the
  colour: t = phase & 0xFFF, mirrored to 0x1000 - t when bit 0x1000 is set, colour = (start x (0x1000 - t) +
  end x t) >> 12 per channel. So the colour runs start, end, start over phase 0, 0x1000, 0x2000.
- One RGB565 pixel is written into the locked surface (0x6D7BB4): no palette, no map lighting, no Z test.

Table at 0x8367C8, ten ints per kind (end RGB, start RGB, random bits, delay mask, rate max, rate min):

| Kind | End | Start | Random bits | Delay mask | Rate |
|---|---|---|---|---|---|
| 0 water | 158, 158, 224 | 40, 40, 80 | 5 | 4095 | 3..12 |
| 1 ore and gems | 255, 255, 240 | 176, 144, 0 | 0 | 4095 | 15..30 |

For ore this gives a 273-546 ms ramp, a 0-4.1 s pause and about 0.41 glints per cell per second.

## HD choices

- Ore and gem cells only; HD water has its own glitter.
- Our own xorshift generator, never the guest's `rand()`; every listed cell advances whether or not it is in view
  (the engine freezes cells out of view, which does not change the stationary rate); no low-frame-rate skip; the
  rect centre ignores the tiles' extra image height.
- Cells under black shroud are not advanced, in place of the unnamed cell conditions.
- The colour is quantised to RGB565 and expanded by bit replication, then drawn as a self-lit pixel (the same
  display path as the ore art), so it keeps its brightness at night.
- The dot is pulled just in front of upright art standing in its own cell; objects in nearer cells and nearer
  terrain hide it. The engine draws it over everything.

## Evidence

Offline sandbox clips at the camera of the recorded `twnk1` clip (XMP27T8 gem field, matched by template search
against the map's terrain picture, 2.5 recorded pixels per game pixel), counted with the same transient-blob rule
as the recorded original (pixel above its temporal median by 50 luma). The results and the scripts are kept with
the remaster's review material outside Git; they are not acceptance of the live game.
