import { describe, expect, it } from 'vitest';
import { Color, Texture, Vector3, Vector4 } from 'three/webgpu';
import { IsoCamera } from '../src/world';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { applyLookPreset, LOOK_PRESETS, type HdSettings } from '../src/HdRenderer';
import { clearLightAt, sunArcDirection } from '../src/lighting';
import type { Ra2Cache } from '../src/ra2/cache';
import { painterObject } from '../src/ra2/painterOrder';
import { ART_LIGHT, shadowTransform } from '../src/ra2/spriteLook';
import { GROUND_PULL, SpriteLayer, groundPlaneDepth, type SpriteInstance } from '../src/ra2/sprites';
import { CARD_CLEARANCE } from '../src/ra2/cardDepth';

const cache = {
  paletteAtlas: { image: { height: 1 } },
  paletteRow: new Map([['unit', 0]]),
  manifest: { spriteAtlas: { width: 256, height: 256 } },
  spriteAtlas: new Texture(),
} as unknown as Ra2Cache;

/** Ground offset (x, z) through the column-major 2x2 shadow matrix. */
const apply = (m: Vector4, x: number, z: number): [number, number] => [m.x * x + m.z * z, m.y * x + m.w * z];

describe('enhanced look: sun arc', () => {
  it('passes the art light azimuth at 15:00 and runs screen right to screen left over the day', () => {
    const e = (40 * Math.PI) / 180;
    const at = (hour: number, night = 0) => sunArcDirection(hour, night, e, new Vector3());
    const horizontal = (v: Vector3) => new Vector3(v.x, 0, v.z).normalize();
    expect(horizontal(at(15)).distanceTo(new Vector3(ART_LIGHT.x, 0, ART_LIGHT.z).normalize())).toBeLessThan(1e-9);
    expect(horizontal(at(6)).distanceTo(new Vector3(1, 0, -1).normalize())).toBeLessThan(1e-9);
    expect(horizontal(at(12)).distanceTo(new Vector3(1, 0, 1).normalize())).toBeLessThan(1e-9);
    expect(horizontal(at(18)).distanceTo(new Vector3(-1, 0, 1).normalize())).toBeLessThan(1e-9);
    // Night hours return to the art's own direction; the elevation is kept.
    expect(horizontal(at(22, 1)).distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-9);
    expect(at(9).y).toBeCloseTo(Math.sin(e), 12);
  });

  it('reads clear-sky sun and sky light from the day keys', () => {
    const { sun, sky } = clearLightAt(12);
    expect(sun.toArray()).toEqual(new Color(1.0, 0.97, 0.92).multiplyScalar(3.2).toArray());
    expect(sky.toArray()).toEqual(new Color(0.62, 0.75, 0.95).toArray());
  });
});

describe('enhanced look: shadows follow the sun', () => {
  it('is the identity without follow and turns and stretches the art shadow direction with it', () => {
    const m = new Vector4();
    shadowTransform(new Vector3(1, 1, 0), 2, 0, m);
    expect(m.toArray()).toEqual([1, 0, 0, 1]);
    // The art's shadow points to -z; at the art's own azimuth only the stretch applies.
    shadowTransform(ART_LIGHT, 1.5, 1, m);
    const [sx, sz] = apply(m, 0, -1);
    expect(sx).toBeCloseTo(0, 12);
    expect(sz).toBeCloseTo(-1.5, 12);
    // Perpendicular offsets keep their length.
    expect(apply(m, 1, 0)[0]).toBeCloseTo(1, 12);
    // A sun from +x throws shadows to -x.
    shadowTransform(new Vector3(1, 0.6, 0), 1, 1, m);
    const [tx, tz] = apply(m, 0, -1);
    expect(tx).toBeCloseTo(-1, 12);
    expect(tz).toBeCloseTo(0, 12);
  });
});

describe('enhanced look: presets', () => {
  it('keeps every effect off in the faithful preset and names a golden hour', () => {
    const settings = {} as HdSettings;
    expect(applyLookPreset(settings, 'faithful')).toBeUndefined();
    for (const key of [
      'relight',
      'specular',
      'glass',
      'occlusion',
      'shadowFollow',
      'shadowSoftness',
      'wetReflections',
    ] as const)
      expect(settings[key]).toBe(0);
    expect(settings.sunPath).toBe('fixed');
    expect(LOOK_PRESETS.golden.hour).toBeGreaterThan(15);
    expect(applyLookPreset(settings, 'golden')).toBe(LOOK_PRESETS.golden.hour);
    expect(settings.sunPath).toBe('arc');
  });
});

type Buffers = { anchor: DirtyAttribute; flags: DirtyAttribute; occlusion: DirtyAttribute };

describe('enhanced look: sprite instances', () => {
  it('keeps the per-instance matrix a single uniform however large the layer', () => {
    const layer = new SpriteLayer(cache, [], 5000);
    expect(layer.mesh.instanceMatrix.count).toBe(1);
    expect(layer.capacity).toBe(5000);
  });

  it('draws contact shades with decals, reflections after shadows and before upright cards', () => {
    const building = painterObject(2, 100);
    building.foundation = [3, 2];
    building.x = 10;
    building.z = 20;
    const base = { frame: { rect: [0, 0, 8, 8], offset: [-4, -8] }, palette: 'unit', push: 0 } as const;
    const make = (x: number, extra: Partial<SpriteInstance>): SpriteInstance => ({
      ...base,
      frame: { rect: [...base.frame.rect], offset: [...base.frame.offset] },
      anchor: new Vector3(x, 0, 0),
      shadow: false,
      ...extra,
    });
    const layer = new SpriteLayer(cache, [], 8);
    layer.setInstances([
      make(1, { painter: building }),
      make(2, { flat: true, kind: 'reflection', painter: building }),
      make(3, { flat: true, shadow: true, painter: building }),
      make(4, { flat: true, kind: 'contact', painter: building }),
      make(5, { flat: true }),
    ]);
    const buffers = layer as unknown as Buffers;
    const order = Array.from(buffers.anchor.array)
      .filter((_, i) => i % buffers.anchor.itemSize === 0)
      .slice(0, 5);
    // Rank 0 keeps insertion order (shadow, contact, decal), then the reflection, then the card.
    expect(order).toEqual([3, 4, 5, 2, 1]);
    const codes = Array.from(buffers.flags.array)
      .filter((_, i) => i % 4 === 0)
      .slice(0, 5);
    expect(codes).toEqual([2, 3, 1, 4, 0]);
    // Every look decal carries the foundation; none of them takes a traversal bias.
    expect(Array.from(buffers.occlusion.array).slice(4, 6)).toEqual([3, 2]);
    expect(
      Array.from(buffers.flags.array)
        .filter((_, i) => i % 4 === 3)
        .slice(0, 4),
    ).toEqual([0, 0, 0, 0]);
  });
});

describe('enhanced look: ground passes', () => {
  it('adds two hidden ground passes that sort just before their layer, whatever its renderOrder', () => {
    const layer = new SpriteLayer(cache, [], 16);
    expect(layer.groundPasses.map((p) => p.name)).toEqual(['ra2-sprites-under', 'ra2-sprites-over']);
    expect(layer.groundPasses.every((p) => !p.visible && p.parent === layer.mesh)).toBe(true);
    layer.mesh.renderOrder = 3;
    const [under, over] = layer.groundPasses;
    expect(under!.renderOrder).toBeCloseTo(2.98, 12);
    expect(over!.renderOrder).toBeCloseTo(2.99, 12);
    // Only the 'under' pass leaves the depth buffer alone; the 'over' pass tests strictly nearer.
    expect((under!.material as { depthWrite: boolean }).depthWrite).toBe(false);
    expect((over!.material as { depthWrite: boolean }).depthWrite).toBe(true);
  });

  it('keeps shadows and reflections behind a card base and ahead of the ground at MSAA sample offsets', () => {
    expect(GROUND_PULL.reflection).toBeLessThan(CARD_CLEARANCE);
    expect(GROUND_PULL.shadow[1]).toBeLessThan(GROUND_PULL.reflection);
    // The ground's depth span from a pixel centre to the farthest sample of the standard 4x MSAA pattern (0.375 px) at
    // 1 engine px per pixel (a pixel is 1 / (60 / sqrt(2)) view units; ground depth changes sqrt(3) per view unit).
    expect(GROUND_PULL.shadow[0]).toBeGreaterThan((0.375 * Math.sqrt(3)) / (60 / Math.SQRT2));
  });

  it('computes the normalised depth of a ground plane under a pixel like the camera projects it', () => {
    const view = new IsoCamera();
    view.target.set(40, 0.8, 55);
    view.resize(1680, 1050);
    view.update();
    const camera = view.camera;
    const coefficients = groundPlaneDepth(camera, 1680, 1050, new Vector4());
    for (const [x, z, y] of [
      [40, 55, 0.8],
      [43.5, 51.25, 0.8],
      [37, 58, 1.6],
    ] as const) {
      const p = new Vector3(x, y, z).project(camera);
      const px = ((p.x + 1) / 2) * 1680;
      const py = ((1 - p.y) / 2) * 1050;
      const viewZ = new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse).z;
      const expected = (-viewZ - camera.near) / (camera.far - camera.near);
      const got = coefficients.x + coefficients.y * px + coefficients.z * py + coefficients.w * y;
      expect(got).toBeCloseTo(expected, 9);
    }
  });
});
