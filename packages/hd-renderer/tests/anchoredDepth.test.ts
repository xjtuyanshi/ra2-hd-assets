import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { anchoredDepthShift, ENHANCED } from '../src/effects';
import { CARD_CLEARANCE, cardDepthPush } from '../src/ra2/cardDepth';
import { PIXELS_PER_CELL_EDGE } from '../src/world';

const toCamera = new Vector3(Math.sqrt(3 / 8), 0.5, Math.sqrt(3 / 8));
const viewDir = toCamera.clone().negate();
const right = new Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
const up = new Vector3(-Math.SQRT1_2 / 2, Math.sqrt(3) / 2, -Math.SQRT1_2 / 2);
const clearance = CARD_CLEARANCE + ENHANCED.anchorBias;

// Nearness in camera-space world units, independent of the orthographic near/far range.
const nearness = (fragment: Vector3, centre: Vector3, ground: number) =>
  fragment.dot(toCamera) + anchoredDepthShift(fragment, centre, ground, viewDir);

describe('ground-anchored billboard depth', () => {
  it('matches the existing vertical card at the ground point for a puff lifted two world units', () => {
    const ground = 3;
    const anchor = new Vector3(4, ground, 6);
    const centre = anchor.clone().add(new Vector3(0, 2, 0));
    for (const x of [-2, 0, 2])
      for (const y of [-1, 0, 1]) {
        const fragment = centre.clone().addScaledVector(right, x).addScaledVector(up, y);
        const relative = fragment.clone().sub(anchor);
        const px = relative.dot(right) * PIXELS_PER_CELL_EDGE;
        const py = -relative.dot(up) * PIXELS_PER_CELL_EDGE;
        // cardDepthPush is already tested against RA2 projection: compare complete depths, not just shifts.
        expect(nearness(fragment, centre, ground)).toBeCloseTo(
          anchor.dot(toCamera) + cardDepthPush(px, py) + ENHANCED.anchorBias,
          10,
        );
      }
  });

  it('intersects the ground plane when the vertical-card intersection is below its base', () => {
    const centre = new Vector3(4, 4, 6);
    const ground = 2;
    const fragment = centre.clone().addScaledVector(up, -4);
    const t = (ground - fragment.y) / viewDir.y;
    const point = fragment.clone().addScaledVector(viewDir, t);
    expect(point.y).toBeCloseTo(ground);
    expect(anchoredDepthShift(fragment, centre, ground, viewDir)).toBeCloseTo(clearance - t, 10);
    expect(nearness(fragment, centre, ground)).toBeCloseTo(point.dot(toCamera) + clearance, 10);
  });

  it('keeps a unit card 1.5 cells in front nearer at every puff fragment, including the lower ground-following rim', () => {
    const ground = 2;
    const anchor = new Vector3(4, ground, 6);
    const centre = anchor.clone().add(new Vector3(0, 2, 0));
    const horizontal = new Vector3(toCamera.x, 0, toCamera.z).normalize();
    const unit = anchor.clone().addScaledVector(horizontal, 1.5);
    for (let x = -2; x <= 2; x += 0.25)
      for (let y = -2; y <= 2; y += 0.25) {
        const fragment = centre.clone().addScaledVector(right, x).addScaledVector(up, y);
        // Intersect the SAME pixel ray with the foreground unit's vertical card. Its foot-plane depth must not be
        // compared with a puff's top at a different screen pixel; upright cards have their own per-pixel depth.
        const t = unit.clone().sub(fragment).dot(horizontal) / viewDir.dot(horizontal);
        const unitPoint = fragment.clone().addScaledVector(viewDir, t);
        const unitDepth = unitPoint.dot(toCamera) + CARD_CLEARANCE;
        expect(unitDepth).toBeGreaterThan(nearness(fragment, centre, ground));
      }
  });

  it('is invariant to centre lift and view-vector magnitude, and retains clearance at the anchor', () => {
    const fragment = new Vector3(3, 2, 5);
    const centre = new Vector3(4, 9, 6);
    const original = [fragment.clone(), centre.clone(), viewDir.clone()];
    expect(anchoredDepthShift(fragment, centre, 1, viewDir.clone().multiplyScalar(20))).toBeCloseTo(
      anchoredDepthShift(fragment, centre.clone().setY(100), 1, viewDir),
      10,
    );
    expect(anchoredDepthShift(centre, centre, 1, viewDir)).toBeCloseTo(clearance);
    expect([fragment, centre, viewDir]).toEqual(original);
  });
});
