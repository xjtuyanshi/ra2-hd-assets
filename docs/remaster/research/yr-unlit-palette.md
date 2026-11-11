# YR house-converter unlit palette indices (0x83E1AC)

Baseline: Yuri's Revenge 1.001 `gamemd.exe` as supplied by the player, read statically as code and table bytes only
(no runtime or pixel check against a live night or storm frame). The HD counterpart is
`packages/hd-renderer/src/ra2/unlitPalette.ts` (policy and CPU twins) with its use in
`packages/hd-renderer/src/ra2/sprites.ts`; tests are in `packages/hd-renderer/tests/unlitPalette.test.ts`.

## The table

- House colour schemes build their light converters through 0x68C3B0 (ColorScheme 0x68C710 and CreateLightConvert
  0x68C860). It calls the LightConvertClass constructor 0x555DA0 (at 0x68C4E2) with rows = the scheme's shade count
  (`[scheme+0x310]`, 53 for house colours) and the table 0x83E1AC. The two pushes at 0x68C758 and 0x68C889 are the
  only references to the table, and nothing writes to it.
- The table's static bytes 0x83E1AC..0x83E2AB are 1 for indices 0-239, 0 for indices **240-254** and 1 for index 255.
  The builder forces index 0 to transparent regardless (0x55637D..0x556389).
- Converters built without a table (terrain/iso converters, ANIM.PAL, the plain unit-palette ConvertClass) get the
  all-ones default 0x829C20 (0x555E33, 0x5560B2).

## What a zero flag does (row builder 0x556090)

- T = max(0, floor(30 x rows / 200) - 1), capped at (rows - 1) / 2 (0x5561FC..0x556244): T = 6 for 53 rows.
- Row r of a zero-flag index takes the untinted multiplier min(1, r / T) (0x556298..0x5562A8, used at 0x55639A,
  0x5563E4 and 0x55640A..0x55641D). Lit indices take the tinted ramp 2 r C / (rows - 1) (0x5563A2..0x5563DD). The
  MMX builders do the same (0x7DE282..0x7DE29A, 0x7DE36B).
- The lit blitters (0x493CC0, 0x4978C0) pick the row as hi = min(254, I x 261 >> 11) and row = min(52, lo x hi x 52 /
  32258), with lo the per-pixel ABuffer byte, cleared to 127 (0x41139F..0x4114A2) and raised only by alpha-image
  lights. Object light I = 1000 is row 26, 776 is row 20.
- So at the neutral ABuffer byte an unlit index shows its exact palette colour for I >= 236 per mille (row >= 6), is
  never brightened above it, and fades in sixths below: 5/6 for 0.197-0.235, 4/6 for 0.157-0.196, ..., black below
  0.040.

## Night, storms and other events

- The engine has no night mode: night is a low Ambient (with Ground, Level and light sources) in the cell's object
  intensity. A stock night map at about 0.55-0.7 stays far above 0.236.
- Ion Storm (IonAmbient 0.87 by default), nuke, TimeWarp and the Dominator retint the 53-shade house converters
  through 0x53AD00 -> vt+4 -> 0x556145..0x556157 (new converters: 0x555E50). Only the lit ramp takes that colour;
  240-254 keep the untinted multiplier, so they are neither tinted nor darkened.
- The map's own `[Lighting]` Red/Green/Blue never reach house converters: they are built at 1000/1000/1000
  (0x68C764..0x68C773, 0x534D5B..0x534D77).

## Which draws use a house converter

Applies:

- Building bodies and damaged frames: BuildingClass::Draw -> TechnoClass::DrawObject 0x705E00, converter from
  GetRemapColour (vtable 0x1E4 = 0x705D70, 0x705F7D..0x705F87), lit flag 0x800 (0x706148).
- Building anims of every slot: the spawner 0x451A70..0x451AF5 hands an anim the building's converter and brightness
  when ShouldUseCellDrawer (AnimType+0x35C, default 1 at 0x4276A9) is set; in stock artmd only FSIDLE clears it.
  0x705D70 does not check TerrainPalette, so even TerrainPalette buildings' anims take the unit-palette converter
  (inferred, not seen on screen).
- Infantry, SHP vehicles and SHP aircraft: vtable 0x50C = 0x41C090 calls 0x705E00.
- Also, not modelled by the HD sprite path: infantry death anims (0x518AA1..0x518AF9), IsVeins anims
  (0x423122..0x42314B) and overlays (0x5FDB08..0x5FDB9A), building damage-fire anims of types with a custom
  palette (0x441D41), voxel draws in principle (0x707187..0x70719A; whether VPL output reaches 240-254 is not
  checked), tiberium overlays (their scheme carries the table, but they draw at a fixed 1000, where the lit ramp is
  at palette value too), and further unidentified Anim+D4 writers (0x424E88, 0x425352, 0x42538B, 0x426256,
  0x5F5B19, 0x5FD1E7, 0x629DD6, 0x739C1A, 0x739DFE).

Does not apply:

- Standalone anims and effects: the ANIM.PAL converter [0x87F6C0] (0x52BF08, chosen at 0x4232CE), a plain
  53-row ConvertClass with every index on one ramp and no tint. Tiled anims use it directly (0x423630..0x4236F7).
  UseNormalLight anims keep their converter at brightness 1000.
- TerrainPalette buildings (BuildingType+0x1702, 0x4612B4..0x4612CB), body and damaged frames: the cell's iso
  LightConvert (0x705EC1..0x705F59, table 0), all indices lit and map-tinted.
- Plain overlays, terrain objects, terrain tiles, shadows ([0x87F6C4]).
- AltPalette anims (WCCLOUD1-3, PARACH, DEATH_A-F, civilian *DM): ColorScheme::Array[0]+0x30C, a 1-shade scheme
  (0x66D432..0x66D45B), never lit and never retinted (0x53AD4D).

## Storm field bolts (WCLBOLT1/2/3)

They are ordinary `Layer=ground` anims (rulesmd `WeatherConBolts`, spawned at 0x53A34A..0x53A387; the constructor
zeroes Anim+D4 at 0x421EFA): the ANIM.PAL converter, untinted, lit by the bolt cell's object intensity, about 0.87
(row 22, 0.846 of palette) under a default storm. EXPLOLB is UseNormalLight and draws at 1000. The HD effect path
lights them with the scene irradiance instead of the map grade; a sandbox storm measured them at about 0.83/0.87/0.87
of their clear-weather colour per channel, within a few per cent of the engine's uniform 0.846. That is not shown to
be a wrong tint, so the HD effect light is unchanged; a same-moment storm comparison against the original would be
needed to settle the small red deficit.

## HD policy

- `SpriteInstance.houseConverter` marks the sprites of the draws above that the HD sprite layer models: library and
  map-cache building bodies, bibs, make art, delivery doors and attached layers on any palette but `iso`, and
  infantry, SHP vehicles and aircraft (Remapable= does not matter).
- For those pixels the sprite shader replaces the lit colour by the art colour at the engine's untinted multiplier
  (`houseConverterUnlitLevel` of the object level), in the clear-noon scale of the renderer's self-lit attachment. The
  map grade, scene light and event tints, the night desaturation and display transform, local light headroom, night
  window glow and the enhanced look's relight, occlusion, highlights and glass are skipped; the object picture tint
  (Iron Curtain, Force Shield) still applies to the finished colour.
- Edge weight on HD pages: the bilinear tent share of 240-254 texels among the opaque texels of the 3x3 index taps,
  sharpened with smoothstep(0.35, 0.65) (`unlitShare`). The bilinear share is exactly 0.5 on the boundary between an
  unlit and a lit texel, so every unlit texel keeps its full square, including single-texel blinkers, and nothing
  grows past it (no halo); the transition band is about 0.3 original texel, so there is no stair-step seam.
  Transparent taps do not count, so unlit texels on the silhouette stay unlit up to the alpha edge. The native
  (indexed) page uses the shown texel's own index.
- The share splits the fragment between the scene output and the self-lit attachment (`bindUnlitSpriteMaterial`)
  in every sprite pass. The split is linear, so a partly unlit edge pixel sums to its blended colour where the two
  display paths agree (clear noon) and fades smoothly towards the lit side at night.
- Not verified: GPU pixel equivalence against same-frame original captures at night or in a storm, and alpha-image
  lights (which raise the ABuffer byte and so the row) are not modelled.
