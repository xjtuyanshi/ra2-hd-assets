import { Vector3 } from 'three/webgpu';
import type { LightingClass, SpriteFrame } from '../../../ra2-assets/src/manifest';
import type { SpriteInstance } from '../ra2/sprites';
import type { PainterObject } from '../ra2/painterOrder';

/** Reuses the live high-water mark; no instance or position allocation after a scene reaches steady occupancy. */
export class SpritePool {
  /** Painter owner of subsequent upright records; reset by begin so reused records never keep an old owner. */
  painter?: PainterObject;
  deckHeight?: number;
  private readonly instances: SpriteInstance[] = [];
  private used = 0;
  private readonly anchors: Vector3[] = [];
  private anchorsUsed = 0;

  begin(): void {
    this.used = this.anchorsUsed = 0;
    this.painter = undefined;
    this.deckHeight = undefined;
  }

  anchor(): Vector3 {
    const i = this.anchorsUsed++;
    return (this.anchors[i] ??= new Vector3());
  }

  take(
    anchor: Vector3,
    frame: SpriteFrame,
    palette: string,
    push: number,
    shadow: boolean,
    flat = false,
    light = 1,
    lighting: LightingClass = 'ambient',
    painterPart = 0,
  ): SpriteInstance {
    const i = this.used++;
    let instance = this.instances[i];
    if (!instance) {
      instance = { anchor: new Vector3(), frame, palette, push, shadow };
      this.instances[i] = instance;
    }
    instance.anchor.copy(anchor);
    instance.frame = frame;
    instance.palette = palette;
    instance.push = push;
    instance.shadow = shadow;
    instance.infantryShadow = undefined;
    instance.flat = flat;
    instance.glint = undefined;
    instance.light = light;
    instance.lighting = lighting;
    instance.painter = !flat && !shadow ? this.painter : undefined;
    instance.painterPart = painterPart;
    instance.deckHeight = !flat && !shadow ? this.deckHeight : undefined;
    instance.nativeDepth = undefined;
    instance.depthWrite = undefined;
    return instance;
  }
}
