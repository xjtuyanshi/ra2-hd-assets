# Yuri's Revenge scene lighting and light sources

Reverse-engineering notes behind `packages/ra2-assets/src/lights.ts` (the `lights.json` sidecar) and the HD night
presentation in `packages/hd-renderer` (`src/lightField.ts`, `src/ra2/mapLights.ts`, `src/ra2/nightDressing.ts`).
Baseline: the player's own `gamemd.exe`, Yuri's Revenge 1.001 (sha256 `7b8a0685…`), read with the repository's MIX/INI
loaders; no third-party data. Addresses are virtual addresses in that executable.

## Where the numbers come from

| What | Address | Behaviour |
| --- | --- | --- |
| `ScenarioClass::ReadLighting` | 0x68A7F8..0x68AC9A | Reads `[Lighting]` with the CRT `atof` on the leading numeric prefix (`0,01` reads 0, `.5` reads 0.5). Stores Ambient/Red/Green/Blue (and the Ion and Dominator variants) as `int(v * 100 + 0.01)` percent, Ground/Level as `int(v * 1000 + 0.01)` per-mille; x87 `_ftol` truncates. |
| `ScenarioClass` constructor | 0x6838D3..0x683997 | Defaults for missing keys: Ambient 1, Red/Green/Blue 1, Ground 0.05, Level 0.008; IonAmbient 0.87, Ion RGB 0.30/0.40/0.75, IonGround/IonLevel 0; DominatorAmbient 1.5, Dominator RGB 0.85/0.20/0.30, DominatorAmbientChangeRate 0.001. DominatorGround/Level are not set in that range (read as 0). |
| `BuildingTypeClass` light keys | 0x460C8C..0x460DC4 | `LightVisibility` (int, leptons), `LightIntensity`, `LightRedTint`/`LightGreenTint`/`LightBlueTint` stored as `int(v * 1000 + 0.1)`. |
| `BuildingTypeClass` constructor | 0x45DE12 | `LightVisibility` 5000; the tints stay at 1000.0 (per-mille 1000000) when a type sets `LightIntensity` without tints. Kept as is. |
| Light source creation | 0x440D6C, 0x4466D5 | A building creates a `LightSourceClass` only when `LightIntensity != 0`, centred on its foundation: (256x + 128w, 256y + 128h, 104z) leptons. TerrainTypes (TIBTRE ore trees) carry the keys but get no light source. |
| Cell lighting | 0x484180 | See the formula below. |
| Tint normalisation | 0x5558E0 | Divides the summed tint by its largest channel. |

The map's own sections override `rulesmd.ini` for every key above (scenario INIs are merged over rules).

## Per-cell formula (engine units, per-mille integers)

For a cell (x, y) at height level z, with centre (256x + 128, 256y + 128) in leptons, and every light source l with
radius r (LightVisibility), intensity I_l and tint t_l:

```
d  = trunc(hypot(dx, dy))                      light height ignored
f  = floor(1000 * (r - d) / r)                 when d <= r, else the light does not contribute
I  = 1000 * Ambient + sum(I_l * f / 1000) + Level * z - Ground         clamped to [0, 2000]
R,G,B = 1000 * (Red, Green, Blue) + sum(t_l * f / 1000)                each clamped to [0, 2000]
M  = max(R, G, B);  M * 65.536 < 66 gives a black cell
intensity = min(2000, I * M / 1000);  tint = (R, G, B) / M
```

Integer divisions truncate towards zero (negative lights such as `NEGLAMP` darken). `engineCellLight` in
`packages/ra2-assets/src/lights.ts` is an exact port, covered by `packages/ra2-assets/tests/lights.test.ts`.

## Stock scenarios

`gameres/hd-cache/_research/night-lights/all-scenarios-lighting.tsv` (derived from the player's install, not in Git)
lists the `[Lighting]` of every stock scenario and multiplayer map found in the install's MIX archives. Ambient,
rounded to 0.1, over the 220 entries with a `[Lighting]` section:

| Ambient | 0.6 | 0.7 | 0.8 | 0.9 | 1.0 | 1.1 | 1.2 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scenarios | 5 | 28 | 66 | 40 | 77 | 2 | 2 |

The non-lunar 0.6-0.72 group are the maps built as night maps: blue or neutral tints, lamp-post light sources
(`INYELWLAMP`, `INGALITE`, `INBLULMP`, `SNONITLAMP`) and `NEGLAMP` darkening. Lunar maps share this low ambient range
but use dim airless daylight rather than the night presentation. Examples:

| Map (source) | Theater | Ambient | R/G/B | Ground | Level | Light sources |
| --- | --- | --- | --- | --- | --- | --- |
| sov07tmd.map (mapsmd03.mix) | temperate | 0.55 | 0.40/0.40/0.70 | 0 | 0.003 | INORANLAMP x2, NEGLAMP x4, INYELWLAMP x10 |
| XMP06T2 "Urban Rush" (multimd.mix) | temperate | 0.60 | 1/1/1 | 0 | 0.039 | INYELWLAMP x8 |
| Transylv.yro | newurban | 0.60 | 0.9/0.9/1.0 | 0.05 | 0.008 | INBLULMP x4 |
| multimd.mix a6506e58 | snow | 0.68 | 0.75/0.75/1.2 | 0 | 0.028 | INGALITE x8 |
| amazon.mmx | temperate | 0.68 | 0.68/0.80/1.0 | 0 | 0.029 | NEGLAMP x4, INYELWLAMP x5 |
| sov06lmd.map (mapsmd03.mix) | lunar | 0.70 | 1/1/1 | 0.05 | 0.008 | INBLULMP x5, TEMNITLAMP x3 |
| multimd.mix 629413d | snow | 0.75 | 1/1/1.5 | 0 | 0.008 | INGALITE x10 |

Warm mid-ambient maps (for example multimd.mix ac956741, Ambient 0.73 with 1/0.92/0.8) read as dusk. The two cached
maps are day maps: XMP29U2 "The Alamo" (1, 1/0.8/0.68, Ground 0, Level 0) with seven `INGALITE` lamp posts at cells
(59,68) (72,68) (70,51) (58,51) (29,47) (64,13) (58,110), and RiverRam (0.9, 1/0.9/0.9, 0.05, 0.008) with eight inert
`TIBTRE02` ore trees and no light sources.

`INGALITE` (`InvisibleInGame=yes`, LightVisibility 4000, LightIntensity 0.5, tint 0.05/0.05/0.01) is a strong light:
at its centre it adds 0.5 to a night map's ~0.6-0.7 ambient. The engine never draws it; the visible `GALITE` post uses
the same art (`gglite.shp`).

## HD mapping

- `mapAtmosphere`: outside theater `lunar`, the class comes from the authored base ambient `base = Ambient - Ground` and the tint, with lamp
  posts (positive `InvisibleInGame` light sources) as evidence: night when `base <= 0.70`, or `base <= 0.76` with a
  blue tint or with two or more lamp posts (unless the tint is warm); dusk when `base <= 0.76` with a warm tint; day
  otherwise. `Level * medianZ` is deliberately left out of the class: an earlier version classified on
  `Ambient - Ground + Level * medianZ` and staged XMP06T2 (0.60 + 0.039 x 4 = 0.756), multimd a6506e58 = XMP13S4
  (0.68 + 0.028 x 5) and amazon.mmx (0.68 + 0.029 x 6) as day. The height term still sets the night level (what unlit
  ground at the typical height shows). `packages/ra2-assets/tests/lights.test.ts` checks the real (Ambient, RGB,
  Ground, Level, medianZ, lamp posts) of XMP06T2, XMP13S4, amazon.mmx, sov07tmd, Transylv, NOWIMPS and XTN01T2 (all
  night) and of XMP29U2, RiverRam and invasion.mmx (day). Renderers recompute the profile from the sidecar's raw data
  (`sidecarAtmosphere`), including the theater, so sidecars written by an older classifier stage maps the current way.
  Theater `lunar` takes the airless day profile described below; an omitted theater retains the prior classifier.
- Linear light from engine brightness: `engineToLinear(e) = 0.30 * (e / 0.62)^2.2` (the palette scales display
  values, so linear light scales by v^2.2); a typical stock night (0.62) shows unlit ground at 30 % of noon. Night maps
  are clamped to 26-40 % of noon so every night stays readable.
- Light sources: the engine grid's difference to the unlit grid is added as irradiance, staged by the map's class
  (`mapLightStaging` in `packages/hd-renderer/src/ra2/mapLights.ts`). Night maps get the engine exactly (full
  `LightVisibility`, linear falloff, full strength, at the night ambient `nightBaseAmbient`): their mappers tuned
  lamps and `NEGLAMP` darkening for that formula. Dusk maps get the same at their own ambient, always on, as the
  engine applies light sources at every hour. A day map forced to night is an HD presentation choice, not the engine:
  with the full 15.6-cell radius the seven `INGALITE` washes on XMP29U2 lit the park lawn to 0.77 of noon, a floodlit
  field, while the moon alone gives 0.26; there each source is a pool (0.45 x `LightVisibility`, the engine falloff
  squared via `engineLightDelta`'s `falloffPower`, 0.8 of the engine's strength): about 3.1x the moonlit ground at the
  post, 1.5x three cells out, nothing past seven. By day the light sources are part of the map's day grade instead
  (next item). No night-map cache has been rendered yet, so the night-map staging is unverified on screen.
- The night keys aim 1.15x above the night level (`NIGHT_TONE_COMPENSATION` in `packages/hd-renderer/src/lighting.ts`)
  to offset the Neutral tone mapper's toe, so the displayed ground keeps the intended fraction of noon. Moonlight is
  cool (`MOON_TINT`); only maps built as night maps tint it with their own `[Lighting]`, a day map's grade stays a
  daylight choice.
- Objects take the light at half saturation (`OBJECT_TINT`), a compromise with the engine's untinted object lighting.
- By day the renderer applies the engine's cell light itself (`packages/hd-renderer/src/ra2/mapLighting.ts`): per
  cell `engineCellLight` with the map's `[Lighting]` and light sources, multiplied into the palette colours in their
  own sRGB scale, level x tint for terrain-class art and the level only for objects, as the engine draws them at all
  times. Checked on XMP29U2 against same-moment captures: terrain 1.00/0.81/0.66 of the palette per channel, 1.345x
  next to the `INGALITE` posts (1.340 predicted). Its weight fades with the night weight on day maps and is 0 on maps
  staged as night or dusk, whose light the night presentation above derives from the same data (one owner at a
  time). Airless lunar profiles also leave this grade off: their day keys already own the ambient and tint.
  `mapLightMultipliers` in `packages/ra2-assets/src/iso.ts` (offline previews) uses the same formula.

## Lunar daylight and ore/gem brightness

The C1 baseline is the user's original-versus-HD measurement on the same frozen MoonPatr frame at 2x. A 480 x 320
box of flat regolith, restricted to low-saturation pixels, gave the following readings. These are baseline evidence,
not measurements of the implementation after C1.

| Presentation | Regolith L* median / standard deviation | Regolith a* / b* | Gem HSV V median / p95 |
| --- | --- | --- | --- |
| Original YR | 47 / 14 (speckled grain) | -3 / -3 | 0.53 / 0.97 |
| HD classified as night | not recorded | not recorded / about -17 | 0.35 / 0.50 |
| HD forced to noon (`hd-time=12`) | 75 / not recorded | not recorded / -9 | 0.71 / 0.85 |

MoonPatr's `[Lighting]` is Ambient `0.65`, Red `1`, Green `1`, Blue `1.1`, Ground `0.05`, Level `0.008`. Its base
intensity is `0.60`; the height term gives roughly `0.62` on the measured ground. The original engine scales palette
sRGB code values by cell intensity, so a factor near `0.62` corresponds to about `0.33-0.36` in linear light. This
explains the original L* 47 versus forced-noon L* 75 without inventing moonlight or a blue sky. Gem highlights instead
reach V p95 `0.97`, essentially the unlit art's p95 `0.96`: on this map, ore/gem overlays retain art brightness while
the ground is dimmed.

The map policy in `packages/ra2-assets/src/lights.ts` therefore handles theater `lunar` before the terrestrial
ambient classifier. It returns `kind: 'day'`, `hour: 12`, the authored tint, `airless: true`, and the optional linear
scene-light multiplier:

```
base = Ambient - Ground
engineToLinear(e) = 0.30 * (e / 0.62)^2.2
exposure = clamp(engineToLinear(base + Level * medianZ) / engineToLinear(1.0), 0.2, 1)
```

`engineToLinear(1.0)` is approximately `0.857`; MoonPatr's exposure is about `0.36`. Height affects this brightness,
not the lunar day classification. Non-lunar maps keep their existing results and omit the optional fields:
Transylv (`newurban`, Ambient `0.60`, RGB `0.9/0.9/1.0`) remains night, and XMP29U2 remains day.

In `packages/hd-renderer/src/lighting.ts`, the day keys scale both sun and hemisphere intensity by exposure. Their
sun, fill, ground and sky swatches use luminance-matched greys times `tint / Y(tint)`, where
`Y(c) = 0.2126 R + 0.7152 G + 0.0722 B`. Thus flat ground receives `exposure * noonFlatLuminance()` and the map's
small blue component remains the sole illuminant tint. Sky/haze and cinematic colour controls must not reintroduce
terrestrial blue. The renderer also keeps exposure adaptation from lifting the authored dimness and avoids applying
the map's palette-domain ambient/tint grade a second time. Default staging stays at noon with night dressing off.

Ore/gem brightness is a game-layer sprite-class policy: when exposure is below 1, library overlays whose extracted
type has `tiberium: true` get `lightGain = 1 / exposure`; other classes get 1. The generic sprite renderer multiplies
received light by this per-instance gain without knowing any RA2 overlay names. The noon reference remains fixed,
so the gain cancels scene dimming for ore/gem art without brightening the ground or other overlays. Profiles without
exposure retain the existing path.

Visual acceptance remains **UNVERIFIED** for C1: the task prohibits starting a server or browser. To verify on an
existing owner-run scene, freeze MoonPatr at the same frame and compare original with default HD staging, then
repeat the regolith crop and gem samples above. Check near-neutral, dim, grain-preserving regolith, bright gem
highlights, no lamp/night dressing, and no blue haze under the cinematic look. Repeat on Transylv and XMP29U2 to
check that night and terrestrial day staging are unchanged. No new disassembly inspection was performed for C1;
the ore/gem palette or `LightConvert` selection path and its addresses remain unverified, so the overlay exception
is supported by the reported same-frame measurements rather than an inferred executable address.

## Open questions

- Land types 13 and 14 hold both ground and pavement; the surface classes use tile colours (`classifyTileSurface`),
  checked on XMP29U2 and RiverRam only.
- `DominatorGround`/`DominatorLevel` defaults and `NukeAmbientChangeRate` were not decoded.
- Spotlights (`[Structures]` field 11) are recorded by the research probe but not drawn.
