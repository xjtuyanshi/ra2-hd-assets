import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTexture, RedFormat, UnsignedByteType, type Material } from 'three/webgpu';
import { float } from 'three/tsl';
import { isWaterFamilyTile } from '../../ra2-assets/src/waterMask';
import { AtmosphereNodes } from '../src/atmosphere';
import { ra2Screen, type Ra2Cache } from '../src/ra2/cache';
import { HARD_SHORE_FALLOFF, hardShoreField } from '../src/ra2/hardShore';
import { buildRa2Terrain } from '../src/ra2/terrain';
import * as waterLook from '../src/ra2/waterLook';
import { waterPreset, type WaterStyle } from '../src/ra2/waterLook';
import type { ShaderNode } from '../src/tsl';

const SUB = 2;
/** Composite of the fixtures: 60 x 30 engine px per cell, the origin left of cell (0, height) and above cell (0, 0). */
const layout = (width: number, height: number, levels = 0) => ({
  originX: -height * 30,
  originY: -levels * 15,
  scale: 1,
  width: (width + height) * 30,
  height: (width + height) * 15 + levels * 15,
});

/** A mask with water painted over the given cells' ground diamonds (or part of them), drawn at their level. */
function paintMask(
  ref: ReturnType<typeof layout>,
  cells: { x: number; y: number; level?: number; part?: (u: number, v: number) => boolean }[],
) {
  const data = new Uint8Array(ref.width * ref.height);
  for (const { x, y, level = 0, part = () => true } of cells)
    for (let j = 0; j < 60; j++)
      for (let i = 0; i < 60; i++) {
        const u = (i + 0.5) / 60;
        const v = (j + 0.5) / 60;
        if (!part(u, v)) continue;
        const [sx, sy] = ra2Screen(x + u, y + v, level);
        const px = Math.floor(sx - ref.originX);
        const py = Math.floor(sy - ref.originY);
        if (px >= 0 && py >= 0 && px < ref.width && py < ref.height) data[py * ref.width + px] = 255;
      }
  return { data, width: ref.width, height: ref.height };
}

const node = (field: Float32Array, width: number, x: number, y: number) => field[y * (width * SUB + 1) + x]!;

describe('which tiles the extractor can mark water in', () => {
  it('open water and the shore families, not cliffs that stand in the sea', () => {
    const tile = (file: string, terrainType = 13) => ({ file, terrainType });
    for (const file of ['water01.sno', 'shore12.tem', 'wbrdge03.urb', 'w-b-02.tem'])
      expect(isWaterFamilyTile(tile(file))).toBe(true);
    expect(isWaterFamilyTile(tile('anything01.tem', 9))).toBe(true);
    // The feet of these are painted with water that the whole-cell mask does not have.
    for (const file of ['wcliff07.sno', 'wclifx02.sno', 'cliff31.tem', 'pshore04.urb', 'ovrps01.urb', 'clear01.des'])
      expect(isWaterFamilyTile(tile(file))).toBe(false);
  });
});

describe('hard shores from tiles and the painted-waterline mask', () => {
  // One row of cells along x: open sea, a cliff foot with water painted in its front half, rock, then far away a
  // beach cell (water on its seaward half) and the sea beyond it.
  const width = 12;
  const height = 3;
  const ref = layout(width, height);
  const kinds: Record<number, 'sea' | 'cliff' | 'beach'> = {
    0: 'sea',
    1: 'sea',
    2: 'cliff',
    9: 'beach',
    10: 'sea',
    11: 'sea',
  };
  const cell = (x: number, y: number) =>
    y === 1 && x < width ? { level: 0, waterFamily: kinds[x] === 'sea' || kinds[x] === 'beach' } : null;
  const mask = paintMask(ref, [
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1, part: (u) => u < 0.5 },
    { x: 9, y: 1, part: (u) => u > 0.5 },
    { x: 10, y: 1 },
    { x: 11, y: 1 },
  ]);
  const field = hardShoreField(width, height, SUB, cell, mask, ref);

  it('is full on the cliff-foot cell and one node around it, and gone three nodes away', () => {
    expect(HARD_SHORE_FALLOFF).toEqual({ full: 1, none: 3 });
    // Nodes of the cliff-foot cell (x 2..3 = lattice 4..6, y 1..2 = lattice 2..4).
    for (let y = 2; y <= 4; y++) for (let x = 4; x <= 6; x++) expect(node(field, width, x, y)).toBe(1);
    // One node out, over the open sea and over the rock behind: still full.
    expect(node(field, width, 3, 3)).toBe(1);
    expect(node(field, width, 7, 3)).toBe(1);
    // Two nodes out: half; three and beyond: none.
    expect(node(field, width, 2, 3)).toBe(0.5);
    expect(node(field, width, 8, 3)).toBe(0.5);
    expect(node(field, width, 1, 3)).toBe(0);
    expect(node(field, width, 9, 3)).toBe(0);
    for (const value of field) expect(value === 0 || value === 0.5 || value === 1).toBe(true);
  });

  it('leaves a beach a beach: water in a shore tile is not a hard shore', () => {
    for (let x = 16; x <= 22; x++) for (let y = 0; y <= height * SUB; y++) expect(node(field, width, x, y)).toBe(0);
  });

  it('needs water at the cell: rock a cell away from any water is no shore', () => {
    const farSea = paintMask(ref, [{ x: 0, y: 1 }]);
    expect(Array.from(hardShoreField(width, height, SUB, cell, farSea, ref)).every((value) => value === 0)).toBe(true);
  });

  it('finds a strip of water a fifth of a cell wide along the foot of the rock', () => {
    const strip = paintMask(ref, [{ x: 2, y: 1, part: (_u, v) => v > 0.8 }]);
    expect(node(hardShoreField(width, height, SUB, cell, strip, ref), width, 5, 3)).toBe(1);
  });

  it('counts rock painted right up to its cell edge, with the sea starting in the next cell', () => {
    // No water inside the cliff-foot cell (2, 1) at all: the open sea of cell (1, 1) touches its edge.
    const touching = paintMask(ref, [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
    const cliffBesideSea = (x: number, y: number) => (y === 1 && x < width ? { level: 0, waterFamily: x < 2 } : null);
    const touched = hardShoreField(width, height, SUB, cliffBesideSea, touching, ref);
    expect(node(touched, width, 5, 3)).toBe(1);
    // The rock two cells inland touches no water.
    expect(node(touched, width, 12, 3)).toBe(0);
  });

  it('reads the mask where the cell is drawn: at its own height level, at any mask resolution', () => {
    const raised = layout(width, height, 4);
    const high = (x: number, y: number) => (y === 1 && x === 5 ? { level: 4, waterFamily: false } : null);
    // Water painted where a level-4 cell (5, 1) is drawn, 60 engine px above its ground-level place.
    const drawn = paintMask(raised, [{ x: 5, y: 1, level: 4 }]);
    expect(node(hardShoreField(width, height, SUB, high, drawn, raised), width, 11, 3)).toBe(1);
    const flat = (x: number, y: number) => (y === 1 && x === 5 ? { level: 0, waterFamily: false } : null);
    expect(node(hardShoreField(width, height, SUB, flat, drawn, raised), width, 11, 3)).toBe(0);
    // The same mask at half resolution (a 2x terrain with a 1x mask) gives the same answer.
    const half = {
      data: new Uint8Array((raised.width / 2) * Math.ceil(raised.height / 2)),
      width: raised.width / 2,
      height: Math.ceil(raised.height / 2),
    };
    for (let y = 0; y < half.height; y++)
      for (let x = 0; x < half.width; x++)
        half.data[y * half.width + x] = drawn.data[Math.min(raised.height - 1, y * 2) * raised.width + x * 2]!;
    expect(node(hardShoreField(width, height, SUB, high, half, raised), width, 11, 3)).toBe(1);
  });

  it('reads a fitted terrain mask (fractional scale, size rounded up) at the same places', () => {
    // A map too wide for 2x is fitted at a multiple of 1/256 (ra2-assets terrainScale.ts): 451/256 for a 9300 px one.
    const scale = 451 / 256;
    const fitted = { ...ref, scale, width: Math.ceil(ref.width * scale), height: Math.ceil(ref.height * scale) };
    expect(fitted.width).not.toBe(ref.width * scale);
    const data = new Uint8Array(fitted.width * fitted.height);
    for (let y = 0; y < fitted.height; y++)
      for (let x = 0; x < fitted.width; x++) {
        // Fitted pixel x covers original [x / scale, (x + 1) / scale): take the original pixel under its centre.
        const sx = Math.min(ref.width - 1, Math.floor((x + 0.5) / scale));
        const sy = Math.min(ref.height - 1, Math.floor((y + 0.5) / scale));
        data[y * fitted.width + x] = mask.data[sy * ref.width + sx]!;
      }
    const fittedMask = { data, width: fitted.width, height: fitted.height };
    expect(Array.from(hardShoreField(width, height, SUB, cell, fittedMask, fitted))).toEqual(Array.from(field));
  });
});

describe('the look at a hard shore', () => {
  it('sees deep water wherever the water covers a hard shore, and the unchanged distance on a beach and on land', () => {
    const { depth, cover } = waterLook.HARD_SHORE;
    // The enhanced look's turquoise shallows end at 0.42 cells of depth, the classic look's at 0.9.
    for (const painted of [0, 0.01, 0.1, 0.3, 1, 4]) {
      expect(waterLook.hardShoreDistance(painted, 1, 1)).toBeCloseTo(painted + depth, 12);
      expect(waterLook.hardShoreDistance(painted, 1, 1)).toBeGreaterThan(0.9);
    }
    // The distance field is coarser than the mask: under the first pixels of water it can still say "land". Covered
    // water is deep there too (it was drawn as bared sand: a yellow sliver along the rock).
    for (const painted of [-0.05, -0.01]) expect(waterLook.hardShoreDistance(painted, 1, 1)).toBe(depth);
    expect(waterLook.hardShoreDistance(-0.02, 1, cover)).toBe(depth);
    // A beach (hard = 0) is untouched at any distance and coverage, and so is dry land at a hard shore: the
    // waterline stays the mask's, to the pixel.
    for (const painted of [-3, -0.5, -0.01, 0, 0.01, 0.2, 2])
      for (const waterness of [0, 0.5, 1]) expect(waterLook.hardShoreDistance(painted, 0, waterness)).toBe(painted);
    for (const painted of [-3, -0.5, -0.01, 0]) expect(waterLook.hardShoreDistance(painted, 1, 0)).toBe(painted);
    // Monotonic in the coverage across the soft edge of the water.
    let previous = -Infinity;
    for (let waterness = 0; waterness <= 1.0001; waterness += 0.05) {
      const value = waterLook.hardShoreDistance(-0.01, 1, waterness);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('drops the cliff-foot contact shading on the land beside the water and returns it inland', () => {
    const { near, far } = waterLook.HARD_SHORE_CONTACT;
    expect(far).toBeLessThan(near);
    expect(near).toBeLessThanOrEqual(-1); // The rock a cliff paints at its foot is a cell and more deep.
    for (const painted of [near, -1, -0.2, 0]) expect(waterLook.hardShoreRelief(painted, 1)).toBe(1);
    for (const painted of [far, far - 1]) expect(waterLook.hardShoreRelief(painted, 1)).toBe(0);
    expect(waterLook.hardShoreRelief((near + far) / 2, 1)).toBeCloseTo(0.5, 12);
    expect(waterLook.hardShoreRelief(-0.2, 0)).toBe(0); // A beach under a cliff keeps its shading.
    expect(waterLook.hardShoreRelief(-0.2, 0.5)).toBe(0.5);
    // The water keeps the shading: it reads as depth under the cliff.
    expect(waterLook.hardShoreRelief(0.3, 1, 1)).toBe(0);
    expect(waterLook.hardShoreRelief(0, 1, 0.25)).toBe(0.75);
  });

  it('builds every output from its inputs', () => {
    const inputsOf = (root: ShaderNode) => {
      const seen = new Set<ShaderNode>();
      const visit = (n: ShaderNode) => {
        if (!n || seen.has(n)) return;
        seen.add(n);
        for (const child of n.getChildren()) visit(child);
      };
      visit(root);
      return seen;
    };
    const painted = float(0.2);
    const hard = float(1);
    const calm = float(0);
    const waterness = float(1);
    const out = waterLook.hardShoreInputs(painted, hard, calm, waterness);
    for (const input of [painted, hard, waterness]) expect(inputsOf(out.shore).has(input)).toBe(true);
    for (const input of [calm, hard]) expect(inputsOf(out.calm).has(input)).toBe(true);
    expect(inputsOf(out.beach).has(hard)).toBe(true);
    for (const input of [painted, hard, waterness]) expect(inputsOf(out.relief).has(input)).toBe(true);
  });
});

const originalStyle = waterPreset.style;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  waterPreset.style = originalStyle;
  vi.restoreAllMocks();
});

/**
 * A strip of sea (x 0..5) meeting a cliff-foot cell (x 6) with rock behind it, with whole-map art. `painted` selects
 * a mask that follows the painted waterline (water reaches into the cliff-foot cell) and the sidecar flag.
 */
function terrain(style: WaterStyle, painted: boolean, theater?: string, waterBed = false) {
  waterPreset.style = style;
  const width = 10;
  const ref = { file: 'terrain.png', ...layout(width, 1) };
  const exists = new Uint8Array(width).fill(1);
  const tile = new Uint16Array(width);
  for (let x = 0; x < width; x++) tile[x] = x < 6 ? 0 : x === 6 ? 1 : 2;
  const pixel = () => new DataTexture(new Uint8Array([32, 64, 96, 255]), 1, 1);
  const bytes = paintMask(ref, [
    ...[0, 1, 2, 3, 4, 5].map((x) => ({ x, y: 0 })),
    ...(painted ? [{ x: 6, y: 0, part: (u: number) => u < 0.4 }] : []),
  ]);
  const mask = new DataTexture(bytes.data, bytes.width, bytes.height, RedFormat, UnsignedByteType);
  const textures = { art: pixel(), mask, shore: pixel() };
  const nodes = new AtmosphereNodes();
  const cache = {
    nodes,
    exists,
    height: new Uint8Array(width),
    tile,
    mapLight: null,
    manifest: {
      theater,
      grid: { width, height: 1 },
      tiles: [
        { terrainType: 9, rampType: 0, file: 'water01.sno', rect: [0, 0, 1, 1], anchor: [0, 0] },
        { terrainType: 15, rampType: 0, file: 'wcliff07.sno', rect: [0, 0, 1, 1], anchor: [0, 0] },
        { terrainType: 13, rampType: 0, file: 'clear01.sno', rect: [0, 0, 1, 1], anchor: [0, 0] },
      ],
    },
    terrainMap: {
      texture: textures.art,
      waterMask: textures.mask,
      shore: textures.shore,
      cliff: null,
      waterBed,
      waterDetail: null,
      waterSurface: null,
      paintedWaterline: painted,
      ref,
    },
  } as unknown as Ra2Cache;
  const inputs = vi.spyOn(waterLook, 'hardShoreInputs');
  const build = buildRa2Terrain(cache);
  cleanups.push(() => {
    build.mirrorAtlas?.dispose();
    for (const material of build.mesh.material as Material[]) material.dispose();
    build.mesh.geometry.dispose();
    build.heightTexture.dispose();
    for (const texture of Object.values(textures)) texture.dispose();
    nodes.dispose();
  });
  const ground = (build.mesh.material as unknown as { colorNode: ShaderNode; emissiveNode: ShaderNode }[])[0]!;
  const reached = new Set<ShaderNode>();
  const visit = (n: ShaderNode) => {
    if (!n || reached.has(n)) return;
    reached.add(n);
    for (const child of n.getChildren()) visit(child);
  };
  visit(ground.colorNode);
  visit(ground.emissiveNode);
  const attributes = [...reached]
    .map((n) => (n as unknown as { _attributeName?: string })._attributeName)
    .filter((name): name is string => typeof name === 'string');
  return { build, inputs, reached, attributes };
}

describe('hard shores in the terrain material', () => {
  it.each(['enhanced', 'classic'] as const)(
    'gives the %s look the hard-shore inputs on a map whose mask follows the painted waterline',
    (style) => {
      const { build, inputs, reached, attributes } = terrain(style, true);
      const hard = build.mesh.geometry.getAttribute('hardShore');
      expect(hard).toBeTruthy();
      const position = build.mesh.geometry.getAttribute('position');
      const wall = build.mesh.geometry.getAttribute('wall');
      let onCliffFoot = 0;
      let farAtSea = 0;
      for (let v = 0; v < position.count; v++) {
        if (wall.getX(v) === 1) {
          expect(hard.getX(v)).toBe(0);
          continue;
        }
        const x = position.getX(v);
        if (x >= 6 && x <= 7) (expect(hard.getX(v), `vertex at x ${x}`).toBe(1), onCliffFoot++);
        if (x <= 4) (expect(hard.getX(v), `vertex at x ${x}`).toBe(0), farAtSea++);
      }
      // The cell's own nine vertices and its two neighbours' three each on the shared edges.
      expect(onCliffFoot).toBe(15);
      expect(farAtSea).toBeGreaterThan(0);
      // The material: the look's shore inputs come from hardShoreInputs, fed by that attribute.
      expect(inputs).toHaveBeenCalledTimes(1);
      const out = inputs.mock.results[0]!.value as ReturnType<typeof waterLook.hardShoreInputs>;
      // Its hard-shore weight is the tiles' (the attribute) joined with the height step's (the contact attribute).
      const inputsOf = (root: ShaderNode) => {
        const names = new Set<string>();
        const seen = new Set<ShaderNode>();
        const visit = (n: ShaderNode) => {
          if (!n || seen.has(n)) return;
          seen.add(n);
          const name = (n as unknown as { _attributeName?: string })._attributeName;
          if (typeof name === 'string') names.add(name);
          for (const child of n.getChildren()) visit(child);
        };
        visit(root);
        return names;
      };
      const [painted, hardNode, calm, waterness] = inputs.mock.calls[0]!;
      expect([...inputsOf(hardNode)].sort()).toEqual(['contact', 'hardShore']);
      expect([...inputsOf(calm)]).toEqual(['contact']);
      expect(inputsOf(painted).has('hardShore')).toBe(false);
      // The water's coverage does not depend on the hard-shore weight: the waterline is the mask's.
      expect(inputsOf(waterness).has('hardShore')).toBe(false);
      // The look's reflected light is built from the deepened distance and the calm (the albedo's inputs sit inside
      // shader functions this walk cannot see).
      expect(reached.has(out.shore)).toBe(true);
      // Only the enhanced look has surf to calm.
      expect(reached.has(out.calm)).toBe(style === 'enhanced');
      void attributes;
    },
  );

  it('treats every shore of a snow map as a hard one, whatever its mask: ice is not a beach', () => {
    for (const painted of [false, true]) {
      const { build, inputs } = terrain('enhanced', painted, 'snow');
      expect(!!build.mesh.geometry.getAttribute('hardShore')).toBe(painted);
      expect(inputs).toHaveBeenCalledTimes(1);
      // The weight is the constant 1: no tile or height test can turn the look's sand beach back on.
      const hard = inputs.mock.calls[0]![1] as unknown as { value?: number; node?: { value?: number } };
      expect(hard.node?.value ?? hard.value).toBe(1);
      const seen = new Set<unknown>();
      const attributes: string[] = [];
      const visit = (n: { getChildren(): Iterable<unknown>; _attributeName?: string }) => {
        if (!n || seen.has(n)) return;
        seen.add(n);
        if (typeof n._attributeName === 'string') attributes.push(n._attributeName);
        for (const child of n.getChildren()) visit(child as never);
      };
      visit(hard as never);
      expect(attributes).toEqual([]);
      inputs.mockClear();
    }
  });

  it.each(['temperate', 'urban', 'newurban', 'desert', undefined])(
    "keeps the look's beach on %s maps with the whole-cell mask",
    (theater) => {
      const { inputs } = terrain('enhanced', false, theater);
      expect(inputs).not.toHaveBeenCalled();
    },
  );

  it('leaves the painted lake bed its own shoreline, even on a snow map', () => {
    const bed = terrain('enhanced', false, 'snow', true);
    expect(bed.inputs).not.toHaveBeenCalled();
    bed.inputs.mockClear();
    // The classic look has no bed optics: a snow lake map drawn with it has ice shores like any other snow map.
    expect(terrain('classic', false, 'snow', true).inputs).toHaveBeenCalledTimes(1);
  });

  it('leaves a map with the whole-cell mask exactly as it was: no attribute, no hard-shore inputs', () => {
    const { build, inputs, attributes } = terrain('enhanced', false);
    expect(build.mesh.geometry.getAttribute('hardShore')).toBeUndefined();
    expect(inputs).not.toHaveBeenCalled();
    expect(attributes).not.toContain('hardShore');
  });
});
