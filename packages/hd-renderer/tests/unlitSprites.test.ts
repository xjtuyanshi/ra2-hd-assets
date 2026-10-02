import { describe, expect, it } from 'vitest';
import {
  Color,
  DataTexture,
  Mesh,
  OrthographicCamera,
  RenderTarget,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { mrt, output, vec4 } from 'three/tsl';
import { AtmosphereNodes } from '../src/atmosphere';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { Lighting } from '../src/lighting';
import { SpritePool } from '../src/live/spritePool';
import type { Ra2Cache } from '../src/ra2/cache';
import { SpriteLayer, isUnlitMapOverlay, type SpriteInstance } from '../src/ra2/sprites';
import { ART_REFERENCE_HOUR, ART_SKY_SHARE, SpriteLookState, updateUnlitSpriteLook } from '../src/ra2/spriteLook';
import { clearLightAt } from '../src/lighting';

const base: SpriteInstance = {
  anchor: new Vector3(),
  frame: { rect: [0, 0, 4, 4], offset: [0, 0] },
  palette: 'theater',
  push: 0,
  shadow: false,
  flat: true,
  lighting: 'none',
};
function cache(): Ra2Cache {
  const atlas = new DataTexture(new Uint8Array(256 * 4), 256, 1);
  return {
    nodes: new AtmosphereNodes(),
    spriteAtlas: atlas,
    paletteAtlas: atlas,
    paletteRow: new Map([['theater', 0]]),
    manifest: { spriteAtlas: { width: 256, height: 1 } },
  } as unknown as Ra2Cache;
}
const settings = { relight: 0.65, sunGain: 1.6, lightContrast: 1.5, sunPath: 'arc' as const };
const lum = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('self-lit ore and gem overlays', () => {
  it('keeps the extractor classification in static and live map-cache fallback records', () => {
    expect(isUnlitMapOverlay({ kind: 'overlay', lighting: 'none' })).toBe(true);
    for (const lighting of ['full', 'ambient', undefined] as const)
      expect(isUnlitMapOverlay({ kind: 'overlay', lighting })).toBe(false);
    expect(isUnlitMapOverlay({ kind: 'tree', lighting: 'none' })).toBe(false);
    expect(isUnlitMapOverlay({ kind: 'smudge', lighting: 'none' })).toBe(false);
    const pool = new SpritePool();
    const ore = pool.take(base.anchor, base.frame, base.palette, 0, false, true);
    ore.unlit = true;
    pool.begin();
    expect(pool.take(base.anchor, base.frame, base.palette, 0, false).unlit).toBeUndefined();
  });

  it('encodes the self-lit policy without changing ordinary ungraded/tree/terrain/object classes', () => {
    const layer = new SpriteLayer(cache(), [
      { ...base, unlit: true },
      base,
      { ...base, lighting: 'full' },
      { ...base, lighting: 'ambient' },
    ]);
    const flags = (layer as unknown as { flags: DirtyAttribute }).flags;
    expect([0, 1, 2, 3].map((i) => flags.array[i * flags.itemSize + 2])).toEqual([3, 2, 1, 0]);
    for (const mesh of [layer.mesh, ...layer.groundPasses]) {
      expect(mesh.material.mrtNode?.has('unlit')).toBe(true);
      mesh.material.dispose();
      mesh.dispose();
    }
    layer.mesh.geometry.dispose();
  });

  it.each(['fixed', 'arc'] as const)(
    'matches the clear-noon crystal light and retains it at dusk/night/storm (%s)',
    (sunPath) => {
      const state = new SpriteLookState();
      updateUnlitSpriteLook(state, { ...settings, sunPath });
      const noon = new Lighting(2, 2);
      noon.update(12, 0);
      const flat = noon.flatIrradianceColor(new Color());
      noon.sunArc = sunPath === 'arc';
      noon.update(12, 0);
      const reference = clearLightAt(ART_REFERENCE_HOUR);
      const sun = noon.sun.color.clone().multiplyScalar(noon.sun.intensity);
      const sky = noon.hemi.color.clone().multiplyScalar(noon.hemi.intensity);
      state.unlitSunLight.value
        .toArray()
        .forEach((c, i) => expect(c).toBeCloseTo((sun.toArray()[i]! * Math.PI) / flat.toArray()[i]!, 12));
      for (const [actual, expected] of [
        [state.unlitSunWeight.value, sun.clone().multiplyScalar(settings.sunGain / lum(reference.sun))],
        [
          state.unlitSkyWeight.value,
          sky.clone().multiplyScalar(ART_SKY_SHARE / lum(reference.sky) / settings.lightContrast),
        ],
        [state.unlitSkyLight.value, new Color(sky.r / flat.r, sky.g / flat.g, sky.b / flat.b)],
      ])
        actual!.toArray().forEach((c, i) => expect(c).toBeCloseTo(expected!.toArray()[i]!, 12));
      const snapshot = () => [
        state.unlitRelight.value,
        ...state.unlitBaseLight.value.toArray(),
        ...state.unlitSunDirection.value.toArray(),
        ...state.unlitSunWeight.value.toArray(),
        ...state.unlitSkyWeight.value.toArray(),
        ...state.unlitSunLight.value.toArray(),
        ...state.unlitSkyLight.value.toArray(),
      ];
      const expected = snapshot();
      for (const [hour, overcast] of [
        [18.2, 0],
        [22, 0],
        [16.5, 1],
      ]) {
        noon.update(hour!, overcast!);
        state.relight.value = 0;
        state.sunDirection.value.copy(noon.state.sunDirection);
        state.sunLight.value.copy(noon.sun.color).multiplyScalar(noon.sun.intensity);
        state.skyLight.value.copy(noon.hemi.color).multiplyScalar(noon.hemi.intensity);
        updateUnlitSpriteLook(state, { ...settings, sunPath });
        expect(snapshot()).toEqual(expected);
      }
      updateUnlitSpriteLook(state, { ...settings, sunPath: 'fixed' });
      expect(state.unlitBaseLight.value.toArray()).toEqual([1, 1, 1]);
    },
  );
});

/** Real r186 shader generation without initializing a browser/device. */
function shader(mesh: Mesh, unlit: boolean, namedTarget = true): string {
  const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  renderer.hasFeature = () => false;
  renderer.hasCompatibility = () => false;
  const target = new RenderTarget(1, 1, { count: unlit ? 2 : 1 });
  target.textures[0]!.name = namedTarget ? 'output' : '';
  if (unlit) target.textures[1]!.name = 'unlit';
  renderer.setRenderTarget(target);
  renderer.setMRT(unlit ? mrt({ output, unlit: vec4(0, 0, 0, output.a) }) : null);
  const backend = renderer.backend as unknown as {
    capabilities: { getUniformBufferLimit(): number };
    createNodeBuilder(
      mesh: Mesh,
      renderer: WebGPURenderer,
    ): {
      camera: OrthographicCamera;
      scene: Scene;
      build(): void;
      fragmentShader: string;
    };
  };
  backend.capabilities.getUniformBufferLimit = () => 65536;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  builder.scene = new Scene();
  builder.build();
  target.dispose();
  return builder.fragmentShader;
}

describe('self-lit sprite MRT', () => {
  it('builds the indexed/HD main and ground passes with and without the unlit attachment', () => {
    for (const hd of [false, true]) {
      const source = cache();
      const layer = new SpriteLayer(
        source,
        [{ ...base, unlit: true, glint: 1 }],
        1,
        undefined,
        hd ? { color: source.spriteAtlas, remap: source.spriteAtlas } : null,
        null,
        { texture: source.spriteAtlas },
      );
      for (const mesh of [layer.mesh, ...layer.groundPasses]) {
        expect(shader(mesh, true)).toMatch(/@location\(\s*1\s*\) m1/);
        expect(shader(mesh, false)).not.toMatch(/@location\(\s*1\s*\) m1/);
        // Three's water reflector clears renderer MRT and uses an unnamed target. Its material colour still needs
        // a fragment output; mapping only named MRT attachments would silently remove all reflected sprites.
        const reflected = shader(mesh, false, false);
        expect(reflected).toContain('@location( 0 ) m0 : vec4<f32>');
        expect(reflected).toContain('output.m0 = Output;');
        mesh.material.dispose();
        mesh.dispose();
      }
      layer.mesh.geometry.dispose();
    }
  });
});
