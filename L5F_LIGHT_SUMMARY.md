# L5F reactor light delivery

NAPOWR now uses a saturated plasma orb and five forked arcs in a generic, fixed-capacity emissive overlay. Its display-linear colour is composited after tone mapping and grading, before sRGB encoding, and never feeds bloom. The ground pool is a foundation-centred, hole-free Euclidean profile (radius 2.6; night RGB `[0.15, 0.42, 2.55]`, day share 0.33). The state gate suppresses placement/build-up flashes; the field and overlay share a 0.5-second fade. Ground, walls and sprites limit summed local light by hue-preserving white headroom. Faithful keeps its previous post graph and bypasses the clamp. Other building specs, attack/effect colours, grade parameters, water and assets are unchanged.

Reflection exclusion checks both the current MRT and the actual target's named `emissive` texture before the scene render list is built. three 0.186.1 `ReflectorNode` clones camera layers but clears MRT for its nested render, so camera layers alone are insufficient. The visibility stack excludes both meshes from mirrors and restores the main pass afterward. Unsupported MRT blending and debug/faithful graphs omit the overlay.

Validation:

- `pnpm --filter hd-renderer run typecheck`: passed.
- Requested Vitest suites, new overlay/headroom tests, shader-layout and affected live regressions: 127 passed.
- `pnpm run check`: passed; 237 suites, 2269 tests passed, 2 existing skips, production build passed.
- Changed files formatted with `pnpm exec prettier --write`; `git diff --check` passed.
- Repository-wide `format:check` reports the unchanged `packages/ra2-assets/python/tree_redraw_spec.example.json`; it was left outside this change.

UNVERIFIED: browser/GPU pixel acceptance, pavement L* change, arc/orb framing and foreground coverage, reflection images, faithful pixel identity and performance. WGSL generation/layout and graph tests do not replace the reviewer's rendering measurements. The extra full-resolution emissive attachment increases render-target memory; its adapter cost needs measurement.

No push was performed.
