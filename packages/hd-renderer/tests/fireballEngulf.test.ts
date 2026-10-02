import { DataTexture, Vector3, type InstancedBufferAttribute, type InstancedMesh } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { anchoredDepthShift, EffectsLayer, ENHANCED } from '../src/effects';
import type { EffectArt } from '../src/live/effectArt';
import {
  EffectSpriteLayer,
  effectSphereRadius,
  MESH_IDLE_SECONDS,
  type EffectInstance,
} from '../src/live/effectSprites';
import { LiveEffectsDriver } from '../src/live/effects';
import { EFFECT_TABLE } from '../src/live/effectTable';
import type { Ra2Cache } from '../src/ra2/cache';
import { CARD_CLEARANCE, cardDepthPush, cardGroundExcess } from '../src/ra2/cardDepth';
import {
  FIREBALL_VOLUME,
  fireballDepthBias,
  fireballRadius,
  packEffectDrawRadius,
  sphereDepthBias,
  unpackEffectDrawRadius,
} from '../src/ra2/fireballDepth';
import { MAX_PAINTER_BIAS } from '../src/ra2/painterOrder';
import { PIXELS_PER_CELL_EDGE } from '../src/world';

import {
  anchor,
  blast,
  crops,
  displayed,
  fireDepth,
  horizontal,
  right,
  toCamera,
  unitPointOnRay,
  up,
  viewDir,
} from './fixtures/fireball';

describe('fireball sphere depth (P-L5H-3)', () => {
  it('uses a spherical front surface and the CURRENT displayed diameter with a shared clamp', () => {
    const r = FIREBALL_VOLUME.maxRadius;
    const margin = 1.5 / Math.cos(Math.PI / 6) - MAX_PAINTER_BIAS - FIREBALL_VOLUME.anchorBias - r;
    expect(margin).toBeGreaterThan(0.03);
    expect(margin - 0.01).toBeLessThan(0.03);
    expect(sphereDepthBias(0, r)).toBe(r);
    expect(sphereDepthBias(0.6 * r, r)).toBeCloseTo(0.8 * r, 12);
    for (const distance of [r, r + 1, r * 2]) expect(sphereDepthBias(distance, r)).toBe(0);
    expect(sphereDepthBias(0, 0)).toBe(0);
    expect(fireballRadius(100)).toBe(r);
    expect(fireballRadius(-1)).toBe(0);
    for (const crop of crops) {
      const card = blast(crop);
      expect(effectSphereRadius(card)).toBeCloseTo(
        Math.min(r, (Math.max(crop.width, crop.height) * 1.3) / (2 * PIXELS_PER_CELL_EDGE)),
        12,
      );
      card.hd!.size = 0.4;
      expect(effectSphereRadius(card)).toBeCloseTo(
        (Math.max(crop.width, crop.height) * 0.4) / (2 * PIXELS_PER_CELL_EDGE),
        12,
      );
      expect(effectSphereRadius(blast(crop, false))).toBeCloseTo(
        Math.max(crop.width, crop.height) / (2 * PIXELS_PER_CELL_EDGE),
        12,
      );
    }
  });

  it.each(
    crops.flatMap((crop) => [
      { ...crop, hd: true, style: 'HD' },
      { ...crop, hd: false, style: 'native' },
    ]),
  )('engulfs 0.8-1.2 high bushes 0.5, 0.8 and 1.0 cells ahead in $style $id inner pixels', (crop) => {
    const card = blast(crop, crop.hd);
    const { lo, width, height, cx, cy } = displayed(card);
    const radius = effectSphereRadius(card);
    for (const distance of [0.5, 0.8, 1])
      for (const treeHeight of [0.8, 1, 1.2]) {
        let overlaps = 0;
        let formerlyExposed = 0;
        for (let x = -0.45; x <= 0.45; x += 0.025)
          for (let h = 0; h <= treeHeight; h += 0.025) {
            const point = anchor
              .clone()
              .addScaledVector(horizontal, distance)
              .addScaledVector(right, x)
              .add(new Vector3(0, h, 0));
            const relative = point.clone().sub(anchor);
            const sx = relative.dot(right);
            const sy = relative.dot(up);
            if (
              sx < lo.x ||
              sx > lo.x + width ||
              sy > lo.y ||
              sy < lo.y - height ||
              Math.hypot(sx - cx, sy - cy) > 0.6 * radius
            )
              continue;
            const treeDepth = point.dot(toCamera) + CARD_CLEARANCE;
            expect(fireDepth(card, sx, sy) - treeDepth).toBeGreaterThan(0.03);
            const oldDepth =
              anchor.dot(toCamera) +
              cardDepthPush(sx * PIXELS_PER_CELL_EDGE, -sy * PIXELS_PER_CELL_EDGE) +
              MAX_PAINTER_BIAS;
            if (treeDepth > oldDepth) formerlyExposed++;
            overlaps++;
          }
        expect(overlaps).toBeGreaterThan(30);
        expect(formerlyExposed).toBeGreaterThan(30);
      }
  });

  it.each(crops)('keeps every $id fragment behind a unit 1.5 cells ahead, including its lower rim', (crop) => {
    const card = blast(crop);
    // Grow TWLT070 just enough to exercise the maximum supported R too, retaining real display offsets.
    card.hd!.size = Math.max(1.3, (FIREBALL_VOLUME.maxRadius * 2 * PIXELS_PER_CELL_EDGE) / crop.width);
    expect(effectSphereRadius(card)).toBeCloseTo(FIREBALL_VOLUME.maxRadius, 12);
    const { lo, width, height } = displayed(card);
    for (let x = 0; x <= 80; x++)
      for (let y = 0; y <= 80; y++) {
        const sx = lo.x + (width * x) / 80;
        const sy = lo.y - (height * y) / 80;
        const fragment = anchor.clone().addScaledVector(right, sx).addScaledVector(up, sy);
        const foreground = unitPointOnRay(fragment, 1.5).dot(toCamera) + CARD_CLEARANCE;
        expect(foreground - fireDepth(card, sx, sy)).toBeGreaterThan(0.03);
      }
  });

  it('keeps explosion fire puffs and their lower ground rim behind the existing 1.5-cell unit with margin', () => {
    for (const lift of [0.2, 0.5, 2]) {
      const centre = anchor.clone().add(new Vector3(0, lift, 0));
      for (let x = -2; x <= 2; x += 0.05)
        for (let y = -0.5; y <= 2; y += 0.05) {
          // The lifted-two puff also covers the complete original [-2,2] test range without ground double counting.
          const sy = lift === 2 ? y * 1.6 - 1.2 : y;
          const fragment = centre.clone().addScaledVector(right, x).addScaledVector(up, sy);
          const puff =
            fragment.dot(toCamera) + anchoredDepthShift(fragment, centre, anchor.y, viewDir, FIREBALL_VOLUME.maxRadius);
          expect(unitPointOnRay(fragment, 1.5).dot(toCamera) + CARD_CLEARANCE - puff).toBeGreaterThan(0.03);
        }
    }
  });

  it.each([-1, -0.5, 2.5])('retains same-ray ordering for a tree/unit at distance %s', (distance) => {
    for (const crop of crops) {
      const card = blast(crop);
      const { lo, width, height } = displayed(card);
      for (let x = 0; x <= 30; x++)
        for (let y = 0; y <= 30; y++) {
          const sx = lo.x + (width * x) / 30;
          const sy = lo.y - (height * y) / 30;
          const fragment = anchor.clone().addScaledVector(right, sx).addScaledVector(up, sy);
          const point = unitPointOnRay(fragment, distance);
          // Below a rear tree's base, compare its ground-following rows too, exactly like cardDepthPush.
          const base = anchor.clone().addScaledVector(horizontal, distance);
          const relative = fragment.clone().sub(base);
          const tree =
            base.dot(toCamera) +
            cardDepthPush(relative.dot(right) * PIXELS_PER_CELL_EDGE, -relative.dot(up) * PIXELS_PER_CELL_EDGE);
          if (distance < 0) expect(fireDepth(card, sx, sy)).toBeGreaterThan(tree);
          else expect(point.dot(toCamera) + CARD_CLEARANCE).toBeGreaterThan(fireDepth(card, sx, sy));
        }
    }
  });

  it('keeps a foreground building facade beyond R in front, including a merged lead', () => {
    for (const crop of crops)
      for (const depthBias of [0, 2.2]) {
        const card = { ...blast(crop), depthBias };
        const { lo, width, height } = displayed(card);
        // A merged lead intentionally retains a legacy footprint larger than R; do not reinterpret that existing
        // 2.2-depth reach as a 1.16 sphere. Its foreground case stands beyond BOTH profiles, at 2.5 cells.
        for (const distance of depthBias ? [2.5] : [FIREBALL_VOLUME.maxRadius + 0.05, 2.5]) {
          const building = anchor.clone().addScaledVector(horizontal, distance);
          for (let x = 0; x <= 30; x++)
            for (let y = 0; y <= 30; y++) {
              const sx = lo.x + (width * x) / 30;
              const sy = lo.y - (height * y) / 30;
              const fragment = anchor.clone().addScaledVector(right, sx).addScaledVector(up, sy);
              const relative = fragment.sub(building);
              const facade =
                building.dot(toCamera) +
                cardDepthPush(
                  relative.dot(right) * PIXELS_PER_CELL_EDGE,
                  -relative.dot(up) * PIXELS_PER_CELL_EDGE,
                  1,
                  1,
                );
              expect(facade).toBeGreaterThan(fireDepth(card, sx, sy));
            }
        }
      }
  });

  it('uses max with legacy merged-building engulf, and never adds sphere to the lower ground intersection', () => {
    const radius = FIREBALL_VOLUME.maxRadius;
    const centre = MAX_PAINTER_BIAS + FIREBALL_VOLUME.anchorBias + radius;
    expect(fireballDepthBias(0, radius, 0.9)).toBe(centre);
    expect(fireballDepthBias(0, radius, 2.2)).toBe(2.2);
    expect(fireballDepthBias(radius, radius, 2.2)).toBe(2.2);
    expect(fireballDepthBias(0, 0, 2.2)).toBe(2.2);
    const py = 20;
    const combined = cardDepthPush(0, py) + fireballDepthBias(0, radius, MAX_PAINTER_BIAS, py);
    const uprightSphere = CARD_CLEARANCE - (py * Math.tan(Math.PI / 6)) / PIXELS_PER_CELL_EDGE + centre;
    expect(combined).toBeCloseTo(Math.max(cardDepthPush(0, py) + MAX_PAINTER_BIAS, uprightSphere), 12);
    expect(cardGroundExcess(py)).toBeGreaterThan(0);
    // A synthetic 1x1 building's front facade at its NW anchor is 1.633 camera units forward: legacy 2.2 engulf
    // still hides it. A facade 2.5 horizontal cells farther forward remains in front of this merged lead.
    expect(cardDepthPush(0, -20) + fireballDepthBias(0, radius, 2.2, -20)).toBeGreaterThan(cardDepthPush(0, -20, 1, 1));
    expect(2.5 / Math.cos(Math.PI / 6) + cardDepthPush(0, -20, 1, 1)).toBeGreaterThan(
      cardDepthPush(0, -20) + fireballDepthBias(0, radius, 2.2, -20),
    );
  });
});

describe('explosion selection and packed instance data', () => {
  it('uses the displayed same-page frame union, holding a different-page successor', () => {
    const card = blast();
    card.hd!.size = 0.7;
    card.hd!.next = { ...card.hd!.frame, offset: [-40, -45] };
    expect(effectSphereRadius(card)).toBeCloseTo((75 * 0.7) / (2 * PIXELS_PER_CELL_EDGE), 12);
    card.hd!.next.page = 1;
    expect(effectSphereRadius(card)).toBeCloseTo((70 * 0.7) / (2 * PIXELS_PER_CELL_EDGE), 12);
  });

  it.each(['explosion', 'collapse', 'smoke', 'muzzle', 'debris', 'impact', 'fire', undefined] as const)(
    'limits volume policy by category %s, draw and pass',
    (category) => {
      for (const draw of ['card', 'flat', 'shadow'] as const)
        for (const pass of ['air', 'ground', 'top'] as const) {
          const radius = effectSphereRadius({ ...blast(), category, draw, pass });
          if (draw === 'card' && pass === 'air' && (category === 'explosion' || category === 'collapse'))
            expect(radius).toBeGreaterThan(0);
          else {
            expect(radius).toBe(0);
            expect(sphereDepthBias(0, radius)).toBe(0);
            expect(fireballDepthBias(0, radius)).toBe(0);
          }
        }
    },
  );

  it('round-trips draw mode and radius through Float32 without adding an attribute', () => {
    for (const draw of [0, 1, 2])
      for (const radius of [0, 0.0001, 0.3, 0.99, FIREBALL_VOLUME.maxRadius]) {
        const decoded = unpackEffectDrawRadius(Math.fround(packEffectDrawRadius(draw, radius)));
        expect(decoded.draw).toBe(draw);
        expect(decoded.radius).toBeCloseTo(radius, 6);
      }
  });

  it.each(['faithful', 'enhanced'] as const)(
    'propagates effect-table categories into the actual %s card buffers',
    (style) => {
      const texture = new DataTexture(new Uint8Array(256 * 4), 256, 1);
      const card = blast();
      const art = {
        ready: true,
        anim: () => ({ art: { layer: 'air', start: 0, frameCount: 1 }, sprite: { frames: [card.frame] } }),
        hdAnim: () => ({ scale: 2, frames: [card.hd!.frame] }),
        hdPageState: () => 'loading',
      } as unknown as EffectArt;
      const driver = new LiveEffectsDriver({ setBeams() {} } as unknown as EffectsLayer, () => false);
      driver.style = style;
      driver.garnishEnabled = false;
      const types = [
        'TWLT070',
        'EXPLOLRG',
        'EXPLOMED',
        'EXPLOSML',
        'TWLT100',
        'S_BANG48',
        'CACH06DM',
        'SMOKEY2',
        'APMUZZLE',
      ];
      driver.push(
        {
          anims: types.map((type, uid) => ({ id: uid, uid, type, x: 0, y: 0, z: 0, frame: 0 })),
          bullets: [],
          particleSystems: [],
        },
        1,
        0,
        new Vector3(),
      );
      const cards: EffectInstance[] = [];
      driver.cards(art, () => 'anim', cards);
      expect(cards.map((c) => c.category)).toEqual(types.map((id) => EFFECT_TABLE[id]!.c));
      const cache = { paletteAtlas: texture, paletteRow: new Map([['anim', 0]]) } as unknown as Ra2Cache;
      const atlas = { texture, width: 256, height: 1 };
      const layer = new EffectSpriteLayer(
        cache,
        () => atlas,
        undefined,
        () => atlas,
      );
      try {
        layer.setInstances(cards, 0);
        const page = [
          ...(layer as unknown as { meshes: Map<string, { style: InstancedBufferAttribute }> }).meshes.values(),
        ][0]!;
        for (let i = 0; i < cards.length; i++) {
          const packed = style === 'enhanced' ? page.style.getX(i) : page.style.getY(i);
          const decoded = unpackEffectDrawRadius(packed);
          expect(decoded.draw).toBe(0);
          expect(decoded.radius).toBeCloseTo(effectSphereRadius(cards[i]!), 6);
        }
      } finally {
        layer.setInstances([], MESH_IDLE_SECONDS + 1);
        texture.dispose();
      }
    },
  );

  it('marks only explosion fire/halos for spheres and leaves muzzle and smoke pools unchanged', () => {
    const layer = new EffectsLayer();
    type Pool = { params: InstancedBufferAttribute; mesh: InstancedMesh };
    const pools = layer as unknown as { garnishFire: Pool; halo: Pool; billow: Pool; column: Pool };
    try {
      layer.explode(0, anchor, 1, new Vector3(), { enhanced: true, hdArt: true, maxSize: 2 });
      expect(pools.garnishFire.params.getW(0)).toBeCloseTo(-1.6, 6);
      expect(-pools.garnishFire.params.getW(0) - 1).toBeCloseTo(0.6, 6);
      expect(pools.halo.params.getW(0)).toBe(-1);
      layer.muzzleFlash(0, anchor, 1, { enhanced: true });
      expect(pools.garnishFire.params.getW(1)).toBeGreaterThanOrEqual(0);
      expect(pools.halo.params.getW(1)).toBeGreaterThanOrEqual(0);
      expect(ENHANCED.anchorBias).toBe(FIREBALL_VOLUME.anchorBias);
    } finally {
      for (const child of layer.root.children) {
        const mesh = child as InstancedMesh;
        mesh.geometry.dispose();
        (mesh.material as import('three/webgpu').MeshBasicNodeMaterial).dispose();
        mesh.dispose();
      }
    }
  });
});
