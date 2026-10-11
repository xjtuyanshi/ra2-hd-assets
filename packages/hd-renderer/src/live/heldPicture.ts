import { Vector3 } from 'three/webgpu';
import type { LightingClass, SpriteFrame } from '../../../ra2-assets/src/manifest';
import type { NativeSpriteDepth } from '../ra2/nativeDepth';
import type { SpriteInstance } from '../ra2/sprites';
import type { SpritePool } from './spritePool';

/** One sprite of a kept picture: what its pool record carried, with the anchor relative to the object's draw point. */
interface HeldSprite {
  delta: Vector3;
  frame: SpriteFrame;
  palette: string;
  indexedHousePaint?: boolean;
  push: number;
  shadow: boolean;
  flat: boolean;
  light: number;
  lighting: LightingClass;
  painterPart: number;
  opacity?: number;
  infantryShadow?: boolean;
  nativeDepth?: NativeSpriteDepth;
  depthWrite?: boolean;
  /** Drawn from the indexed page by design (see LiveView.queue). */
  indexed: boolean;
}

/**
 * The last complete picture of a sprite object (a building's bib, shadow, body and layers; an infantryman's shadow and
 * body), kept while atlas pages its type draws from are still on their way.
 *
 * A change of state can move an object onto art of another page: a building that finishes its build-up, takes damage,
 * is sold, opens its door or starts its production anim; a soldier whose next sequence was packed onto the following
 * page. While that page has not arrived the new picture has nothing to draw from, and the object would be gone (or be
 * left as a shadow, or as layers without a body) until it has. The view shows this picture instead, at the object's
 * present draw point, and changes to the new one in the frame that can draw it completely.
 *
 * Records are copied, not referenced: the view's sprite pool hands the same records out again on the next frame.
 * Anchors are kept relative to the object's draw point, so a kept picture follows an object that moves. Depth
 * profiles are referenced: every frame makes its own and never changes them afterwards.
 */
export class HeldPicture {
  private readonly sprites: HeldSprite[] = [];
  private count = 0;

  /** Sprites in the kept picture; 0 before the first complete one. */
  get size(): number {
    return this.count;
  }

  /** Keep the first `count` of `sprites`, the complete picture just queued for an object whose draw point is `base`. */
  capture(base: Vector3, sprites: readonly SpriteInstance[], indexed: readonly boolean[], count: number): void {
    for (let i = 0; i < count; i++) {
      const from = sprites[i]!;
      let to = this.sprites[i];
      if (!to) {
        to = {
          delta: new Vector3(),
          frame: from.frame,
          palette: from.palette,
          push: 0,
          shadow: false,
          flat: false,
          light: 1,
          lighting: 'ambient',
          painterPart: 0,
          indexed: false,
        };
        this.sprites[i] = to;
      }
      to.delta.copy(from.anchor).sub(base);
      to.frame = from.frame;
      to.palette = from.palette;
      to.indexedHousePaint = from.indexedHousePaint;
      to.push = from.push;
      to.shadow = from.shadow;
      to.flat = !!from.flat;
      to.light = from.light ?? 1;
      to.lighting = from.lighting ?? 'ambient';
      to.painterPart = from.painterPart ?? 0;
      to.opacity = from.opacity;
      to.infantryShadow = from.infantryShadow;
      to.nativeDepth = from.nativeDepth;
      to.depthWrite = from.depthWrite;
      to.indexed = indexed[i] ?? false;
    }
    this.count = count;
  }

  /**
   * Hand the kept picture to `queue` as fresh records of `pool`, standing at `base`. The pool's current painter owner
   * applies, as for the sprites the object would have queued itself.
   */
  replay(pool: SpritePool, base: Vector3, queue: (instance: SpriteInstance, indexed: boolean) => void): void {
    const anchor = pool.anchor();
    for (let i = 0; i < this.count; i++) {
      const sprite = this.sprites[i]!;
      const instance = pool.take(
        anchor.copy(base).add(sprite.delta),
        sprite.frame,
        sprite.palette,
        sprite.push,
        sprite.shadow,
        sprite.flat,
        sprite.light,
        sprite.lighting,
        sprite.painterPart,
      );
      instance.opacity = sprite.opacity;
      instance.indexedHousePaint = sprite.indexedHousePaint;
      instance.infantryShadow = sprite.infantryShadow;
      instance.nativeDepth = sprite.nativeDepth;
      instance.depthWrite = sprite.depthWrite;
      queue(instance, sprite.indexed);
    }
  }
}
