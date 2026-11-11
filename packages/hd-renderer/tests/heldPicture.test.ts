import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import type { SpriteFrame } from '../../ra2-assets/src/manifest';
import { HeldPicture } from '../src/live/heldPicture';
import { SpritePool } from '../src/live/spritePool';
import { painterObject } from '../src/ra2/painterOrder';
import type { SpriteInstance } from '../src/ra2/sprites';

const frame = (x: number, page = 0): SpriteFrame => ({ rect: [x, 0, 20, 30], offset: [-10, -25], page });

/** A building's picture as the view queues it: bib (ground card), shadow, body, a layer drawn 12 px to the right. */
function picture(pool: SpritePool, base: Vector3) {
  const painter = painterObject(2, 100, 0);
  pool.painter = painter;
  const bib = pool.take(base, frame(0), 'lib:unit@live3', 0.2, false);
  bib.nativeDepth = { mode: 'ground', bonus: 2 };
  const shadow = pool.take(base, frame(1), 'lib:unit@live3', 0, true, true);
  const body = pool.take(base, frame(2), 'lib:unit@live3', 0.4, false);
  body.nativeDepth = { mode: 'body', origin: [5, 7], base: 16 };
  body.opacity = 0.5;
  body.indexedHousePaint = true;
  const layer = pool.take(
    base.clone().add(new Vector3(0.1, 0, -0.1)),
    frame(3, 1),
    'lib:unit',
    0.41,
    false,
    false,
    1.2,
    'full',
    0.1,
  );
  layer.depthWrite = false;
  return { painter, sprites: [bib, shadow, body, layer], indexed: [false, true, false, true] };
}

describe('the last complete picture of a sprite object', () => {
  it('is empty until a picture has been kept', () => {
    const held = new HeldPicture();
    expect(held.size).toBe(0);
    const out: SpriteInstance[] = [];
    held.replay(new SpritePool(), new Vector3(), (instance) => out.push(instance));
    expect(out).toEqual([]);
  });

  it('gives back every sprite as it was queued: frame, house palette, depth, opacity, layer and route', () => {
    const pool = new SpritePool();
    pool.begin();
    const base = new Vector3(10, 0.5, 20);
    const p = picture(pool, base);
    const held = new HeldPicture();
    held.capture(base, p.sprites, p.indexed, p.sprites.length);
    expect(held.size).toBe(4);
    const expected = p.sprites.map((sprite) => ({ ...sprite, anchor: sprite.anchor.clone() }));

    // The next frame: the pool hands the same records out again, for other art.
    pool.begin();
    pool.painter = p.painter;
    for (const sprite of p.sprites) {
      sprite.frame = frame(99);
      sprite.palette = 'other';
      sprite.anchor.set(0, 0, 0);
      sprite.nativeDepth = undefined;
    }
    const out: SpriteInstance[] = [];
    const routes: boolean[] = [];
    held.replay(pool, base, (instance, indexed) => {
      out.push(instance);
      routes.push(indexed);
    });
    expect(routes).toEqual(p.indexed);
    expect(out).toHaveLength(4);
    out.forEach((sprite, i) => {
      const was = expected[i]!;
      expect(sprite.frame).toBe(was.frame);
      // The palette row carries the owner's colours: the kept picture wears them unchanged.
      expect(sprite.palette).toBe(was.palette);
      expect(sprite.indexedHousePaint).toBe(was.indexedHousePaint);
      expect(sprite.anchor.distanceTo(was.anchor)).toBeLessThan(1e-9);
      expect(sprite.push).toBe(was.push);
      expect(sprite.shadow).toBe(was.shadow);
      expect(!!sprite.flat).toBe(!!was.flat);
      expect(sprite.light).toBe(was.light);
      expect(sprite.lighting).toBe(was.lighting);
      expect(sprite.painterPart).toBe(was.painterPart);
      expect(sprite.opacity).toBe(was.opacity);
      expect(sprite.depthWrite).toBe(was.depthWrite);
      expect(sprite.nativeDepth).toEqual(was.nativeDepth);
      // Upright cards and shadows belong to the object's painter entry, as when it queued them itself.
      expect(sprite.painter).toBe(was.flat && !was.shadow ? undefined : p.painter);
    });
  });

  it('follows an object that has moved: anchors are kept relative to its draw point', () => {
    const pool = new SpritePool();
    pool.begin();
    const base = new Vector3(4, 0, 6);
    const p = picture(pool, base);
    const held = new HeldPicture();
    held.capture(base, p.sprites, p.indexed, p.sprites.length);
    const offsets = p.sprites.map((sprite) => sprite.anchor.clone().sub(base));
    pool.begin();
    const moved = new Vector3(5.5, 1, 6.25);
    const out: SpriteInstance[] = [];
    held.replay(pool, moved, (instance) => out.push(instance));
    out.forEach((sprite, i) => expect(sprite.anchor.distanceTo(moved.clone().add(offsets[i]!))).toBeLessThan(1e-9));
    // The fourth sprite stood beside the draw point and still does.
    expect(out[3]!.anchor.x - moved.x).toBeCloseTo(0.1, 9);
  });

  it('replaces the kept picture with a later, shorter one', () => {
    const pool = new SpritePool();
    pool.begin();
    const base = new Vector3();
    const p = picture(pool, base);
    const held = new HeldPicture();
    held.capture(base, p.sprites, p.indexed, 4);
    held.capture(base, [p.sprites[2]!], [false], 1);
    expect(held.size).toBe(1);
    pool.begin();
    const out: SpriteInstance[] = [];
    held.replay(pool, base, (instance) => out.push(instance));
    expect(out.map((sprite) => sprite.frame.rect[0])).toEqual([2]);
  });
});
