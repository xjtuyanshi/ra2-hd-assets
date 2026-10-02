import { Vector3 } from 'three/webgpu';
import { effectSphereRadius, type EffectInstance } from '../../src/live/effectSprites';
import { cardDepthPush } from '../../src/ra2/cardDepth';
import { fireballDepthBias } from '../../src/ra2/fireballDepth';
import { MAX_PAINTER_BIAS } from '../../src/ra2/painterOrder';
import { PIXELS_PER_CELL_EDGE } from '../../src/world';

// Exact camera basis from anchoredDepth.test.ts. Compare nearness along the SAME orthographic pixel ray.
export const toCamera = new Vector3(Math.sqrt(3 / 8), 0.5, Math.sqrt(3 / 8));
export const viewDir = toCamera.clone().negate();
export const right = new Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
export const up = new Vector3(-Math.SQRT1_2 / 2, Math.sqrt(3) / 2, -Math.SQRT1_2 / 2);
export const horizontal = new Vector3(toCamera.x, 0, toCamera.z).normalize();
export const anchor = new Vector3(4, 2, 6);

// Synthetic opaque peak-stage crops, not extracted art: TWLT070 has a roughly 70-pixel fireball;
// EXPLOLRG uses a wider 80-pixel plume. Their off-centre crops rise above the ground draw point but retain a
// 12-14 px lower rim. This exercises both the upright sphere and ground-following pixels. HD texels are 2x;
// offsets stay in native pixels, and the live enhanced display multiplier is 1.3.
export const crops = [
  { id: 'TWLT070', width: 70, height: 64, offset: [-35, -50] as [number, number] },
  { id: 'EXPLOLRG', width: 80, height: 72, offset: [-40, -60] as [number, number] },
];
export function blast(crop = crops[0]!, hd = true): EffectInstance {
  const frame = {
    page: 0,
    rect: [0, 0, crop.width, crop.height] as [number, number, number, number],
    offset: crop.offset,
  };
  return {
    anchor: anchor.clone(),
    frame,
    palette: 'anim',
    alpha: 1,
    push: 0,
    draw: 'card',
    pass: 'air',
    depth: 0,
    glow: true,
    category: 'explosion',
    ...(hd
      ? {
          hd: {
            frame: { ...frame, rect: [0, 0, crop.width * 2, crop.height * 2] as [number, number, number, number] },
            next: null,
            scale: 2,
            size: 1.3,
            blend0: 0,
            t0: 0,
            stageSeconds: 0.1,
          },
        }
      : {}),
  };
}
export function displayed(instance: EffectInstance) {
  const size = instance.hd?.size ?? 1;
  const frame = instance.hd?.frame ?? instance.frame;
  const scale = instance.hd?.scale ?? 1;
  const lo = new Vector3(
    (frame.offset[0] * size) / PIXELS_PER_CELL_EDGE,
    (-frame.offset[1] * size) / PIXELS_PER_CELL_EDGE,
    0,
  );
  const width = ((frame.rect[2] / scale) * size) / PIXELS_PER_CELL_EDGE;
  const height = ((frame.rect[3] / scale) * size) / PIXELS_PER_CELL_EDGE;
  return { lo, width, height, cx: lo.x + width / 2, cy: lo.y - height / 2 };
}
export function fireDepth(instance: EffectInstance, sx: number, sy: number) {
  const { cx, cy } = displayed(instance);
  const py = -sy * PIXELS_PER_CELL_EDGE;
  return (
    instance.anchor.dot(toCamera) +
    cardDepthPush(sx * PIXELS_PER_CELL_EDGE, py) +
    fireballDepthBias(
      Math.hypot(sx - cx, sy - cy),
      effectSphereRadius(instance),
      MAX_PAINTER_BIAS + (instance.depthBias ?? 0),
      py,
    )
  );
}
export function unitPointOnRay(fragment: Vector3, distance: number) {
  const unit = anchor.clone().addScaledVector(horizontal, distance);
  const t = unit.sub(fragment).dot(horizontal) / viewDir.dot(horizontal);
  return fragment.clone().addScaledVector(viewDir, t);
}
