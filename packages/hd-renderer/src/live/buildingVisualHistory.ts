import type { LiveObject, LiveSnapshot } from './liveView';

interface LastBuildingVisual {
  object: LiveObject;
  snapshot: LiveSnapshot;
}

interface DeliveryObservation {
  frame: number;
  unloading: LiveObject['unloading'];
}

/**
 * Preserve the last drawable building descriptor through the logic frame after the last one it was published in.
 * Polling can miss the zero-HP state entirely, so eligibility does not depend on health. Explicit hiding and
 * selling take effect immediately. This is bounded presentation compensation, not reconstruction of the native
 * render/present phase.
 *
 * The deadline is counted from the last frame the building was present in, not from the publication that first
 * missed it: the engine removes the building in the middle of a logic tick, before the frame counter advances, so
 * a poll can already miss it under the old frame number while the native picture keeps it until the render after
 * the next increment.
 */
export class BuildingVisualHistory {
  private lastFrame = -1;
  private readonly last = new Map<number, LastBuildingVisual>();
  readonly retained = new Map<number, LastBuildingVisual>();
  /** Per building: the first publication of the newest logic frame and of the one seen before it. */
  private readonly delivery = new Map<number, { current: DeliveryObservation; previous?: DeliveryObservation }>();

  update(snapshot: LiveSnapshot): void {
    if (snapshot.frame < this.lastFrame) this.clear();
    this.lastFrame = snapshot.frame;
    this.retained.clear();
    const ids = new Map(snapshot.objects.map((object) => [object.id, object.uid]));
    const uids = new Set(snapshot.objects.map((object) => object.uid));
    for (const [uid, last] of this.last) {
      if (uids.has(uid)) continue;
      // Repeated publications of a frame do not extend the deadline. A reused pointer, a skipped logic frame or
      // the second logic frame after the last present one cannot revive old art.
      if (ids.has(last.object.id) || snapshot.frame > last.snapshot.frame + 1) {
        this.last.delete(uid);
        continue;
      }
      this.retained.set(uid, last);
    }
    for (const object of snapshot.objects) {
      if (object.kind !== 'building') {
        this.last.delete(object.uid);
        continue;
      }
      // Only the first publication of a logic frame counts: later ones can already carry the next tick's change.
      const seen = this.delivery.get(object.uid);
      if (!seen) this.delivery.set(object.uid, { current: { frame: snapshot.frame, unloading: object.unloading } });
      else if (seen.current.frame !== snapshot.frame) {
        seen.previous = seen.current;
        seen.current = { frame: snapshot.frame, unloading: object.unloading };
      }
      if (object.buildState === 'selling' || object.nativeHidden) {
        this.last.delete(object.uid);
        continue;
      }
      this.last.set(object.uid, { object: { ...object }, snapshot });
    }
    for (const uid of this.delivery.keys()) if (!uids.has(uid) && !this.retained.has(uid)) this.delivery.delete(uid);
  }

  /**
   * The delivery image (`unloading`) to draw for a building in logic frame `frame`: the one its first publication of
   * the previous logic frame carried. The engine changes the state in the middle of a logic tick and renders before
   * the next tick's logic, so its picture shows the old image for the whole frame number in which a poll first sees
   * the change (frozen GAWEAP pairs at one-frame steps: the delivery picture appeared and went one counter stop after
   * the state). Without an observation of exactly the previous frame the current state is drawn.
   */
  shownUnloading(object: Pick<LiveObject, 'uid' | 'unloading'>, frame: number): LiveObject['unloading'] {
    const seen = this.delivery.get(object.uid);
    if (!seen || seen.current.frame !== frame || seen.previous?.frame !== frame - 1) return object.unloading;
    return seen.previous.unloading;
  }

  clear(): void {
    this.last.clear();
    this.retained.clear();
    this.delivery.clear();
    this.lastFrame = -1;
  }
}
