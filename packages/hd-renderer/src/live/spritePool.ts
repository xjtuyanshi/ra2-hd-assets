import { Vector3 } from 'three/webgpu';
import type { LightingClass, SpriteFrame } from '../../../ra2-assets/src/manifest';
import type { SpriteInstance } from '../ra2/sprites';

/** Reuses the live high-water mark; no instance or position allocation after a scene reaches steady occupancy. */
export class SpritePool {
  private readonly instances: SpriteInstance[] = [];
  private used = 0;
  private readonly anchors: Vector3[] = [];
  private anchorsUsed = 0;

  begin(): void {
    this.used = this.anchorsUsed = 0;
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
    instance.flat = flat;
    instance.light = light;
    instance.lighting = lighting;
    return instance;
  }
}
