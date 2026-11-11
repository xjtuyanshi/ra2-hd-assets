import { Vector3 } from 'three/webgpu';
import type { LightingClass, SpriteFrame } from '../../../ra2-assets/src/manifest';
import type { SpriteInstance } from '../ra2/sprites';
import type { PainterObject } from '../ra2/painterOrder';

/** Reuses the live high-water mark; no instance or position allocation after a scene reaches steady occupancy. */
export class SpritePool {
  /** Painter owner of subsequent upright records; reset by begin so reused records never keep an old owner. */
  painter?: PainterObject;
  deckHeight?: number;
  /**
   * Picture tint of the object whose cards are being taken (objectTint.ts: light factor and packed colour); reset
   * by begin and set per object, so every body card, layer and bib of one object carries the same tint.
   */
  tintLight = 1;
  tintColour = 0;
  private readonly instances: SpriteInstance[] = [];
  private used = 0;
  private readonly anchors: Vector3[] = [];
  private anchorsUsed = 0;

  begin(): void {
    this.used = this.anchorsUsed = 0;
    this.painter = undefined;
    this.deckHeight = undefined;
    this.tintLight = 1;
    this.tintColour = 0;
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
    instance.indexedHousePaint = undefined;
    instance.houseConverter = undefined;
    instance.push = push;
    instance.shadow = shadow;
    instance.opacity = undefined;
    instance.infantryShadow = undefined;
    instance.infantryBare = undefined;
    instance.flat = flat;
    instance.glint = undefined;
    instance.unlit = undefined;
    instance.light = light;
    instance.gradeExempt = undefined;
    instance.tintLight = shadow ? 1 : this.tintLight;
    instance.tintColour = shadow ? 0 : this.tintColour;
    instance.lighting = lighting;
    // Upright cards take their depth tie-break from the painter. SHP shadows keep it too, for its foundation only:
    // the cinematic look turns and stretches a building's shadow about the foundation centre, and without it the
    // pivot falls back to the draw point and the shadow lands under or behind the building (map buildings pass
    // their painter for the same reason, world.ts). Flat decals stay ownerless.
    instance.painter = !flat || shadow ? this.painter : undefined;
    instance.painterPart = painterPart;
    instance.deckHeight = !flat && !shadow ? this.deckHeight : undefined;
    instance.nativeDepth = undefined;
    instance.depthWrite = undefined;
    return instance;
  }
}
