import { expect, it } from 'vitest';
import { DataTexture, Group, Mesh, type MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import type { EffectsLayer } from '../src/effects';
import type { InstancedQuad } from '../src/instancedQuad';
import type { EffectArt } from '../src/live/effectArt';
import { EffectSpriteLayer, MESH_IDLE_SECONDS, type EffectInstance } from '../src/live/effectSprites';
import { LiveEffectsDriver, type LiveEffects } from '../src/live/effects';
import { LiveView } from '../src/live/liveView';
import { Projectiles } from '../src/live/projectiles';
import { SpritePool } from '../src/live/spritePool';
import type { VoxelUnits } from '../src/live/voxelUnits';
import type { Ra2Cache } from '../src/ra2/cache';

// Synthetic art only. Each reported Air anim, SHP shell and native particle must reach the same tested pass.
const frame = { rect: [0, 0, 8, 8], offset: [-4, -4], page: 0 } as const;
const art = {
  ready: true,
  anim: () => ({
    art: { layer: 'air', start: 0, frameCount: 1 },
    sprite: { frames: [frame] },
    palette: 'fx:anim',
    remap: false,
  }),
  bullet: () => ({ art: {}, sprite: { frames: [frame] } }),
  particle: () => ({ art: { translucency: 50 }, sprite: { frames: [frame] } }),
} as unknown as EffectArt;

it.each([1, 0.5])('depth-tests Air animations, projectiles and particles with opacity %s', (alpha) => {
  const effects = { setBeams() {} } as unknown as EffectsLayer;
  const driver = new LiveEffectsDriver(effects, () => false);
  driver.garnishEnabled = false;
  const snapshot: LiveEffects = {
    anims: ['S_CLSN22', 'EXPLOSML', 'TSTIMPCT', 'TWNK1'].map((type, uid) => ({
      id: uid,
      uid,
      type,
      x: 64 * 256,
      y: 91 * 256,
      z: 0,
      frame: 0,
    })),
    bullets: [{ id: 9, uid: 9, type: 'SHELL', x: 256, y: 512, z: 104 }],
    particleSystems: [
      {
        id: 10,
        uid: 10,
        behaviour: 'smoke',
        x: 256,
        y: 512,
        z: 0,
        particles: [{ type: 'SMOKE', frame: 0, x: 256, y: 512, z: 104 }],
      },
    ],
  };
  driver.push(snapshot, 1, 0, new Vector3());
  const cards: EffectInstance[] = [];
  expect(driver.cards(art, () => 'fx:anim', cards)).toEqual({ drawn: 4, missing: 0 });
  const projectiles = new Projectiles(art, {} as VoxelUnits, new Group(), () => 'unit');
  projectiles.update(snapshot.bullets, [], () => false, cards);
  const view = { effectArt: art, particlePool: new SpritePool(), shroud: { isLocationShrouded: () => false } };
  const particleCards = (
    LiveView.prototype as unknown as {
      particleCards(this: typeof view, effects: LiveEffects, cards: EffectInstance[]): void;
    }
  ).particleCards;
  particleCards.call(view, snapshot, cards);
  expect(cards).toHaveLength(6);
  expect(cards.every((card) => card.pass === 'air' && card.draw === 'card')).toBe(true);
  const texture = new DataTexture(new Uint8Array(256 * 4), 256, 1);
  const cache = { paletteAtlas: texture, paletteRow: new Map([['fx:anim', 0]]) } as unknown as Ra2Cache;
  const layer = new EffectSpriteLayer(cache, () => ({ texture, width: 256, height: 1 }));
  for (const card of cards) card.alpha = alpha;
  layer.setInstances(cards, 0);
  const mesh = layer.root.children[0] as InstancedQuad;
  expect(mesh.instances).toBe(6);
  expect(mesh.renderOrder).toBe(7);
  expect(mesh.material).toMatchObject({ depthTest: true, depthWrite: false });
  expect((mesh.material as MeshBasicNodeMaterial).depthNode).not.toBeNull();
  layer.setInstances([], MESH_IDLE_SECONDS + 1);
  texture.dispose();
});

it('keeps only native Top animations above black shroud, in a separate transparent draw root', () => {
  const driver = new LiveEffectsDriver({ setBeams() {} } as unknown as EffectsLayer, () => true);
  driver.garnishEnabled = false;
  driver.push(
    {
      anims: ['top', 'air', 'ground', 'surface', 'underground'].map((layer, uid) => ({
        id: uid,
        uid,
        type: 'SYNTHETIC',
        x: 256,
        y: 512,
        z: 1490,
        frame: 0,
        layer: layer as 'top' | 'air' | 'ground' | 'surface' | 'underground',
      })),
      bullets: [],
      particleSystems: [],
    },
    1,
    0,
    new Vector3(),
  );
  const cards: EffectInstance[] = [];
  expect(driver.cards(art, () => 'fx:anim', cards)).toEqual({ drawn: 1, missing: 0 });
  expect(cards[0]!.pass).toBe('top');
  const texture = new DataTexture(new Uint8Array(256 * 4), 256, 1);
  const cache = { paletteAtlas: texture, paletteRow: new Map([['fx:anim', 0]]) } as unknown as Ra2Cache;
  const layer = new EffectSpriteLayer(cache, () => ({ texture, width: 256, height: 1 }));
  try {
    layer.setInstances([...cards, { ...cards[0]!, pass: 'air' }], 0);
    expect(layer.root.children).toHaveLength(1);
    expect(layer.topRoot.children).toHaveLength(1);
    expect(layer.topVisible).toBe(true);
    expect((layer.topRoot.children[0] as Mesh).material).toMatchObject({ depthTest: false, depthWrite: false });
    expect((layer.root.children[0] as Mesh).material).toMatchObject({ depthTest: true, depthWrite: false });
    layer.setInstances([], MESH_IDLE_SECONDS + 1);
    expect(layer.topVisible).toBe(false);
    expect(layer.root.children).toHaveLength(0);
    expect(layer.topRoot.children).toHaveLength(0);
  } finally {
    texture.dispose();
  }
});
