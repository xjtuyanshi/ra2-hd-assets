import { describe, expect, it } from 'vitest';
import {
  DataTexture,
  Mesh,
  OrthographicCamera,
  RenderTarget,
  Scene,
  Texture,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { mrt, output, vec4 } from 'three/tsl';
import { AtmosphereNodes } from '../src/atmosphere';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { HeldPicture } from '../src/live/heldPicture';
import { SpritePool } from '../src/live/spritePool';
import type { Ra2Cache } from '../src/ra2/cache';
import { SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';
import { tintedSrgb } from '../src/objectTint';
import {
  BUILDING_ANIM_USES_HOUSE_CONVERTER,
  HOUSE_CONVERTER_UNLIT_INDICES,
  buildingBodyUsesHouseConverter,
  houseConverterUnlitLevel,
  houseConverterUnlitSrgb,
  isHouseConverterUnlitIndex,
  mapObjectUsesHouseConverter,
  unlitShare,
  unlitTapWeight,
} from '../src/ra2/unlitPalette';

const frame = { rect: [0, 0, 4, 4] as [number, number, number, number], offset: [0, 0] as [number, number] };
const base: SpriteInstance = { anchor: new Vector3(), frame, palette: 'theater', push: 0, shadow: false };

function cache(nodes = new AtmosphereNodes()): Ra2Cache {
  const atlas = new DataTexture(new Uint8Array(256 * 4), 256, 1);
  return {
    nodes,
    spriteAtlas: atlas,
    paletteAtlas: atlas,
    paletteRow: new Map([['theater', 0]]),
    manifest: { spriteAtlas: { width: 256, height: 1 } },
  } as unknown as Ra2Cache;
}

/** Unlit weight of the sample at `at` (texel units) over an index map, as the HD shader forms it. */
function weightAt(indices: (x: number, y: number) => number, at: readonly [number, number]): number {
  const k = [Math.floor(at[0]), Math.floor(at[1])];
  const t: [number, number] = [at[0] - k[0]! - 0.5, at[1] - k[1]! - 0.5];
  let unlit = 0;
  let opaque = 0;
  for (const oy of [-1, 0, 1])
    for (const ox of [-1, 0, 1]) {
      const i = indices(k[0]! + ox, k[1]! + oy);
      if (i === 0) continue;
      const w = unlitTapWeight(ox, oy, t);
      opaque += w;
      if (isHouseConverterUnlitIndex(i)) unlit += w;
    }
  return unlitShare(unlit, opaque);
}

describe('house converter unlit palette indices (gamemd.exe 0x83E1AC)', () => {
  it('is exactly 240-254: 239 and 255 stay lit', () => {
    expect(HOUSE_CONVERTER_UNLIT_INDICES).toEqual({ first: 240, last: 254 });
    const unlit = Array.from({ length: 256 }, (_, i) => i).filter(isHouseConverterUnlitIndex);
    expect(unlit).toEqual(Array.from({ length: 15 }, (_, i) => 240 + i));
  });

  it('draws them at palette value from object light 0.236 up and fades in sixths below (lit blitter rows)', () => {
    for (const level of [2, 1, 0.87, 0.776, 0.55, 0.3, 0.236]) expect(houseConverterUnlitLevel(level)).toBe(1);
    expect(houseConverterUnlitLevel(0.235)).toBeCloseTo(5 / 6, 12);
    expect(houseConverterUnlitLevel(0.197)).toBeCloseTo(5 / 6, 12);
    expect(houseConverterUnlitLevel(0.196)).toBeCloseTo(4 / 6, 12);
    expect(houseConverterUnlitLevel(0.04)).toBeCloseTo(1 / 6, 12);
    expect(houseConverterUnlitLevel(0.039)).toBe(0);
    expect(houseConverterUnlitLevel(0)).toBe(0);
  });

  it('keeps an isolated unlit texel to its own square, without a halo or a hard seam', () => {
    const blinker = (x: number, y: number) => (x === 5 && y === 5 ? 241 : 33);
    expect(weightAt(blinker, [5.5, 5.5])).toBe(1);
    // The texel's own edge is the half-way point; the neighbour's centre takes nothing.
    expect(weightAt(blinker, [6, 5.5])).toBeCloseTo(0.5, 12);
    expect(weightAt(blinker, [6.5, 5.5])).toBe(0);
    expect(weightAt(blinker, [6.5, 6.5])).toBe(0);
    // Monotonic soft band across the edge (no step): about 0.3 texel wide.
    const across = [5.7, 5.8, 5.9, 6, 6.1, 6.2, 6.3].map((x) => weightAt(blinker, [x, 5.5]));
    for (let i = 1; i < across.length; i++) expect(across[i]!).toBeLessThanOrEqual(across[i - 1]!);
    expect(across[0]).toBe(1);
    expect(across[across.length - 1]).toBe(0);
    expect(across.filter((w) => w > 0 && w < 1).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps unlit texels on the silhouette unlit up to the alpha edge (transparent taps do not count)', () => {
    const rim = (x: number, y: number) => (x < 5 ? 0 : x === 5 ? 253 : 40);
    expect(weightAt(rim, [5.1, 3.5])).toBe(1);
    expect(weightAt(rim, [5.5, 3.5])).toBe(1);
    const wall = (x: number) => (x < 5 ? 252 : 40);
    expect(weightAt((x) => wall(x), [5, 0.5])).toBeCloseTo(0.5, 12);
  });

  it('applies to the engine paths of the house converter only', () => {
    // Building pictures follow TerrainPalette (the cell's iso converter, all lit); their anims never do (0x705D70).
    expect(buildingBodyUsesHouseConverter(undefined)).toBe(true);
    expect(buildingBodyUsesHouseConverter(false)).toBe(true);
    expect(buildingBodyUsesHouseConverter(true)).toBe(false);
    expect(buildingBodyUsesHouseConverter(false, 'unit')).toBe(true);
    expect(buildingBodyUsesHouseConverter(true, 'unit')).toBe(false);
    expect(buildingBodyUsesHouseConverter(false, 'iso')).toBe(false);
    expect(BUILDING_ANIM_USES_HOUSE_CONVERTER).toBe(true);
    for (const kind of ['infantry', 'vehicle', 'aircraft']) expect(mapObjectUsesHouseConverter(kind)).toBe(true);
    expect(mapObjectUsesHouseConverter('building')).toBe(true);
    expect(mapObjectUsesHouseConverter('building', true)).toBe(false);
    for (const kind of ['tree', 'overlay', 'smudge']) expect(mapObjectUsesHouseConverter(kind)).toBe(false);
  });

  it('takes the picture tint light as a change of draw intensity: never dimmed above 0.236, never brightened', () => {
    const lamp: [number, number, number] = [1, 0.9, 0.4];
    // Iron Curtain / Force Shield pulse (0.2-0.5, flash to 2), laser designator (1-2), deactivated vehicle (0.5).
    for (const light of [0.3, 0.5, 1, 1.5, 2]) expect(houseConverterUnlitSrgb(lamp, 1, { light })).toEqual(lamp);
    expect(houseConverterUnlitSrgb(lamp, 0.6, { light: 0.5 })).toEqual(lamp);
    // Lit pixels at the same tint do change.
    expect(tintedSrgb(lamp, { light: 0.5 })).not.toEqual(lamp);
    // Only when level x factor drops below 0.236: 1 x 0.2 = 0.2 is the 5/6 row, like a level of 0.2 untinted.
    const dim = houseConverterUnlitSrgb(lamp, 1, { light: 0.2 });
    expect(dim).toEqual(houseConverterUnlitSrgb(lamp, 0.2));
    dim.forEach((v, i) => expect(v).toBeCloseTo((lamp[i]! * 5) / 6, 12));
    // The blitter's added colour (Force Shield blue) applies as to any pixel.
    const added = houseConverterUnlitSrgb([0.2, 0.2, 0.2], 1, { light: 0.4, add: [0, 0, 0.5] });
    expect(added[0]).toBeCloseTo(0.2, 12);
    expect(added[2]).toBeCloseTo(0.2 + 16 / 31, 12);
  });
});

describe('house converter sprites in the sprite layer', () => {
  it('packs the flag beside grade exemption and indexed house paint', () => {
    const layer = new SpriteLayer(cache(), [
      { ...base, houseConverter: true },
      { ...base, houseConverter: true, indexedHousePaint: true, gradeExempt: true },
      { ...base, indexedHousePaint: true },
      base,
    ]);
    const anchor = (layer as unknown as { anchor: DirtyAttribute }).anchor;
    expect([0, 1, 2, 3].map((i) => anchor.array[i * anchor.itemSize + 5])).toEqual([4, 7, 2, 0]);
  });

  it('is reset by the pool and carried by a held picture', () => {
    const pool = new SpritePool();
    const card = pool.take(base.anchor, frame, 'theater', 0, false);
    card.houseConverter = true;
    const held = new HeldPicture();
    held.capture(new Vector3(), [card], [false], 1);
    pool.begin();
    expect(pool.take(base.anchor, frame, 'theater', 0, false).houseConverter).toBeUndefined();
    const replayed: SpriteInstance[] = [];
    held.replay(pool, new Vector3(), (instance) => replayed.push(instance));
    expect(replayed[0]!.houseConverter).toBe(true);
  });

  it.each([false, true])('routes the unlit share to the self-lit attachment in every pass (HD %s)', (hd) => {
    const nodes = new AtmosphereNodes();
    const hdPage = { color: new Texture(), remap: new Texture() };
    const layer = new SpriteLayer(
      cache(nodes),
      [{ ...base, houseConverter: true }],
      1,
      undefined,
      hd ? hdPage : undefined,
    );
    const meshes = [layer.mesh, ...layer.groundPasses];
    meshes.push(layer.readOnlyMesh, layer.unitMesh, layer.translucentMesh);
    for (const mesh of meshes)
      expect((mesh.material as { mrtNode?: { has(n: string): boolean } }).mrtNode?.has('unlit')).toBe(true);
    // r186's WGSL builder (no device), with the renderer's self-lit attachment present.
    const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    const target = new RenderTarget(1, 1, { count: 2 });
    target.textures[0]!.name = 'output';
    target.textures[1]!.name = 'unlit';
    renderer.setRenderTarget(target);
    renderer.setMRT(mrt({ output, unlit: vec4(0, 0, 0, output.a) }));
    const backend = renderer.backend as unknown as {
      createNodeBuilder(
        mesh: Mesh,
        renderer: WebGPURenderer,
      ): { camera: OrthographicCamera; scene: Scene; build(): void; fragmentShader: string };
    };
    for (const mesh of [layer.mesh, layer.unitMesh]) {
      const builder = backend.createNodeBuilder(new Mesh(mesh.geometry, mesh.material), renderer);
      builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
      builder.scene = new Scene();
      builder.build();
      const code = builder.fragmentShader;
      expect(code).not.toMatch(/\b(?:NaN|undefined)\b/);
      expect(code).toContain('spriteUnlitShare');
      expect(code).toContain('spriteHouseConverter');
      // The share is written by the colour graph before the attachment split reads it.
      const written = code.search(/spriteUnlitShare = /);
      expect(written).toBeGreaterThan(-1);
      expect(code.slice(written + 20).search(/\bspriteUnlitShare\b/)).toBeGreaterThan(-1);
      expect(code).toMatch(/max\( \w+, spriteUnlitShare \)/);
      // The unlit level is taken at the object level times the picture tint's light factor (draw intensity).
      const level = code.split('\n').find((line) => /\bspriteUnlitLevel = /.test(line));
      expect(level).toBeDefined();
      expect(level).toMatch(/spriteTintFlat\.x/);
      // The tint's light factor is not applied to the unlit colour: its own tint call passes a light of 1.
      expect(code.match(/objectTintDisplay\w* = /g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(code).toMatch(/output\.m1 = /);
    }
    target.dispose();
    nodes.dispose();
  });
});
