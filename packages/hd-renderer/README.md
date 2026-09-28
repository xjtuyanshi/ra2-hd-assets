# hd-renderer

Base-agnostic HD 2.5D renderer for the RA2 remaster (three.js r186 `WebGPURenderer`, WebGL2 fallback).

It consumes a versioned `RenderState` snapshot (`src/contract.ts`) and never reads or writes engine state, so the same
renderer and assets can sit behind any base: the RA2 VM memory bridge, a reimplementation, or the procedural sandbox.

## Run the sandbox

```bash
pnpm hd:sandbox        # http://localhost:15180
```

Drag to pan, wheel to zoom, click the ground to detonate. URL presets make screenshots comparable:
`?nogui&nohud&cx=13&cy=42&zoom=0.9&time=9.5&weather=rain&rain=0.9&battle=0&webgl=1`.

`node scripts/shots.mjs <outDir>` captures the fixed review presets with Playwright (set `SHOTS_CHROME` to an installed
Chrome if Playwright's bundled headless shell is missing).

## What v0 covers

- RA2-exact projection: 2:1 dimetric orthographic camera, 60x30 px cells, 15 px height levels (`src/world.ts`).
- Terrain: height field with smoothed shading normals, per-pixel procedural materials, soft class borders, wet
  surfaces, puddles, wet shore band, border shroud (`src/terrain.ts`).
- Water: analytic sky reflection, sun sheen, depth tint from the terrain height texture, shoreline foam, rain rings
  (`src/water.ts`).
- Weather: world-anchored GPU rain streaks and splashes (`src/weather.ts`).
- Lighting: fixed classic sun azimuth, time-of-day keys, overcast, soft shadows (`src/lighting.ts`).
- Effects: instanced fireballs, smoke, sparks, scorch decals, pooled flash lights, camera shake (`src/effects.ts`).
- Post: bloom, Neutral/AgX/ACES tone mapping, vignette, FXAA (`src/HdRenderer.ts`).

Units and buildings are placeholders (`src/objects.ts`) until real assets exist; the art pipeline replaces them by
`RenderObject.type`.
