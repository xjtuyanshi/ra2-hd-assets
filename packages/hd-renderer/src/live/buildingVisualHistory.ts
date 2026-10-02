import type { LiveObject, LiveSnapshot } from './liveView';

interface LastBuildingVisual {
  object: LiveObject;
  snapshot: LiveSnapshot;
  missingFrame?: number;
}

/**
 * Preserve the last drawable building descriptor through its first missing logic frame. Polling can miss the
 * zero-HP state entirely, so eligibility does not depend on health. Explicit hiding and selling take effect
 * immediately. This is bounded presentation compensation, not reconstruction of the native render/present phase.
 */
export class BuildingVisualHistory {
  private lastFrame = -1;
  private readonly last = new Map<number, LastBuildingVisual>();
  readonly retained = new Map<number, LastBuildingVisual>();

  update(snapshot: LiveSnapshot): void {
    if (snapshot.frame < this.lastFrame) this.clear();
    this.lastFrame = snapshot.frame;
    this.retained.clear();
    const ids = new Map(snapshot.objects.map((object) => [object.id, object.uid]));
    const uids = new Set(snapshot.objects.map((object) => object.uid));
    for (const [uid, last] of this.last) {
      if (uids.has(uid)) continue;
      last.missingFrame ??= snapshot.frame;
      // Same-frame publications do not extend the deadline. A reused pointer, skipped logic frame or second
      // missing logic frame cannot revive old art, even if the next publication repeats the original frame.
      if (ids.has(last.object.id) || snapshot.frame > last.snapshot.frame + 1 || snapshot.frame !== last.missingFrame) {
        this.last.delete(uid);
        continue;
      }
      this.retained.set(uid, last);
    }
    for (const object of snapshot.objects) {
      if (object.kind !== 'building' || object.buildState === 'selling' || object.nativeHidden) {
        this.last.delete(object.uid);
        continue;
      }
      this.last.set(object.uid, { object: { ...object }, snapshot });
    }
  }

  clear(): void {
    this.last.clear();
    this.retained.clear();
    this.lastFrame = -1;
  }
}
