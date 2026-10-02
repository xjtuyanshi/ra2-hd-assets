/** HD object-state presentation with synthetic snapshots; no renderer, game files or original art. */
import { describe, expect, it } from 'vitest';
import { facingFrame, type InfantrySequence } from '../../packages/ra2-assets/src/art';
import type { LibraryType } from '../../packages/ra2-assets/src/library';
import type { SpriteFrame } from '../../packages/ra2-assets/src/manifest';
import { LiveView, type LiveObject, type LiveSnapshot } from '../../packages/hd-renderer/src/live/liveView';
import { SpritePool } from '../../packages/hd-renderer/src/live/spritePool';
import type { SpriteInstance } from '../../packages/hd-renderer/src/ra2/sprites';

const building: LiveObject = {
  id: 1,
  uid: 10,
  kind: 'building',
  type: 'TEST',
  owner: -1,
  x: 0,
  y: 0,
  z: 0,
  facingRaw: 0,
  health: 1,
  isSelected: false,
};
const buildingType: LibraryType = {
  kind: 'building',
  image: 'TEST',
  sprite: 'body',
  drawOffset: [0, -15],
  lighting: 'ambient',
  remap: true,
  building: { bodyFrames: 1, layers: [], buildup: 'make' },
};

interface VisualState {
  firstFrame: number;
  libraryType: LibraryType;
  paletteKey?: string;
  lastMoveFrame?: number;
  firedFrame?: number;
  deadFrame?: number;
}

interface ViewState {
  push(snapshot: LiveSnapshot, at?: number): void;
  buildupFrame(object: LiveObject, visual: VisualState, frame: number): number | null;
  visualFor(object: LiveObject, colorIndex: number, frame: number): VisualState;
  libraryInfantrySprites(
    object: LiveObject,
    pose: { x: number; y: number; z: number; facing: number },
    visual: VisualState,
    batch: Map<number, SpriteInstance[]>,
    frame: number,
  ): void;
  appearances: Map<number, { frame: number; afterGap: boolean; lastSeen: number }>;
}

/** Exercise the real snapshot/visual methods while leaving unrelated GPU and environment work outside this fixture. */
function view(makeFrames = 25): ViewState {
  return Object.assign(Object.create(LiveView.prototype), {
    current: null,
    previous: null,
    firstFrame: null,
    appearances: new Map(),
    visuals: new Map(),
    houseColour: new Map(),
    housePaletteKeys: new Map(),
    buildingAnimMatches: new Map(),
    effectDriver: {},
    liveBeams: { update() {} },
    cellsFromEngine: true,
    root: { add() {}, remove() {} },
    library: {
      type: () => buildingType,
      library: { sprites: { make: { frames: Array.from({ length: makeFrames }, () => ({})) } } },
    },
    updateOverlays() {},
    updateSmudges() {},
    updateNightSources() {},
  }) as ViewState;
}

function push(target: ViewState, frame: number, objects: LiveObject[] = [building]): void {
  target.push({ frame, objects, houses: [], view: null }, frame);
}

describe('building build-up', () => {
  it('draws the engine stage for building and selling, without reversing a descending selling stage again', () => {
    const target = view();
    const visual = { firstFrame: 9000, libraryType: buildingType };
    expect(target.buildupFrame({ ...building, buildState: 'building', buildupFrame: 7 }, visual, 100)).toBe(7);
    expect(target.buildupFrame({ ...building, buildState: 'selling', buildupFrame: 18 }, visual, 100)).toBe(18);
    expect(target.buildupFrame({ ...building, buildState: 'selling', buildupFrame: 17 }, visual, 101)).toBe(17);
    expect(target.buildupFrame({ ...building, buildState: 'done', buildupFrame: 7 }, visual, 100)).toBeNull();
  });

  it('clamps bridge stages to available make art and keeps a state-only selling object at the last frame', () => {
    const target = view();
    const visual = { firstFrame: 0, libraryType: buildingType };
    expect(target.buildupFrame({ ...building, buildState: 'building', buildupFrame: -1 }, visual, 100)).toBe(0);
    expect(target.buildupFrame({ ...building, buildState: 'building', buildupFrame: 99 }, visual, 100)).toBe(24);
    expect(target.buildupFrame({ ...building, buildState: 'selling' }, visual, 100)).toBe(24);
  });

  it('starts the fallback clock when a snapshot is pushed even if no visual has ever been rendered', () => {
    const target = view();
    push(target, 0, []);
    push(target, 50, []);
    push(target, 100);
    expect(target.appearances.get(building.uid)).toEqual({ frame: 100, afterGap: false, lastSeen: 100 });
    // First render arrives only after the whole 25-frame make animation (2 logic frames per step).
    push(target, 150);
    const visual = target.visualFor(building, -1, 150);
    expect(visual.firstFrame).toBe(100);
    expect(target.buildupFrame(building, visual, 150)).toBeNull();
  });

  it('retains a pushed first-seen frame across uninterrupted snapshots while rendering is suspended', () => {
    const target = view();
    push(target, 0, []);
    push(target, 50, []);
    push(target, 100);
    for (let frame = 110; frame <= 300; frame += 10) push(target, frame);
    const visual = target.visualFor(building, -1, 300);
    expect(visual.firstFrame).toBe(100);
    expect(target.buildupFrame(building, visual, 300)).toBeNull();
  });

  it('assumes a new building after a snapshot gap longer than the fallback build-up time is complete', () => {
    const target = view();
    push(target, 0, []);
    push(target, 100);
    const visual = target.visualFor(building, -1, 100);
    expect(target.appearances.get(building.uid)).toEqual({ frame: 100, afterGap: true, lastSeen: 100 });
    expect(target.buildupFrame(building, visual, 100)).toBeNull();
    // Engine state still takes precedence over the conservative fallback after a gap.
    expect(target.buildupFrame({ ...building, buildState: 'building', buildupFrame: 3 }, visual, 100)).toBe(3);
  });

  it('plays a newly observed building when the preceding snapshot is exactly 54 logic frames older', () => {
    const target = view();
    push(target, 0, []);
    push(target, 60, []);
    push(target, 114);
    const visual = target.visualFor(building, -1, 114);
    expect(target.buildupFrame(building, visual, 114)).toBe(0);
    expect(target.buildupFrame(building, visual, 128)).toBe(7);
    expect(target.buildupFrame(building, visual, 164)).toBeNull();
  });

  it('does not reclassify a known object as complete just because later snapshots have a gap', () => {
    const target = view();
    push(target, 0, []);
    push(target, 50, []);
    push(target, 100);
    push(target, 155);
    expect(target.appearances.get(building.uid)).toEqual({ frame: 100, afterGap: false, lastSeen: 155 });
  });

  it('keeps first-snapshot buildings finished and distinguishes a reused pointer by its new uid', () => {
    const target = view();
    push(target, 100);
    const original = target.visualFor(building, -1, 100);
    expect(target.buildupFrame(building, original, 100)).toBeNull();
    push(target, 150);
    const replacement = { ...building, uid: building.uid + 1 };
    push(target, 200, [replacement]);
    const visual = target.visualFor(replacement, -1, 200);
    expect(target.appearances.get(building.uid)?.frame).toBe(100);
    expect(visual.firstFrame).toBe(200);
    expect(target.buildupFrame(replacement, visual, 200)).toBe(0);
  });

  it('retains first-seen time when the same object temporarily disappears from snapshots', () => {
    const target = view();
    push(target, 100);
    push(target, 150, []);
    push(target, 200);
    const visual = target.visualFor(building, -1, 200);
    expect(visual.firstFrame).toBe(100);
    expect(target.buildupFrame(building, visual, 200)).toBeNull();
  });

  it('tracks only buildings and expires missing entries strictly after the omission tolerance', () => {
    const target = view();
    const others = (['vehicle', 'infantry', 'aircraft'] as const).map((kind, i) => ({
      ...building,
      uid: 20 + i,
      kind,
    }));
    push(target, 100, [building, ...others]);
    expect([...target.appearances.keys()]).toEqual([building.uid]);
    push(target, 154, []);
    expect(target.appearances.has(building.uid)).toBe(true);
    push(target, 155, []);
    expect(target.appearances.size).toBe(0);
    // A new UID reusing the dead object's address receives a new clock.
    const replacement = { ...building, uid: 100 };
    push(target, 156, [replacement]);
    expect([...target.appearances]).toEqual([[100, { frame: 156, lastSeen: 156, afterGap: false }]]);
  });

  it('refreshes presence without changing first appearance and bounds retention during repeated losses', () => {
    const target = view();
    push(target, 0);
    for (let frame = 1; frame <= 200; frame++) push(target, frame, [building, { ...building, uid: 1000 + frame }]);
    expect(target.appearances.get(building.uid)).toEqual({ frame: 0, lastSeen: 200, afterGap: false });
    expect(target.appearances.size).toBe(56);
    push(target, 254, []);
    expect([...target.appearances.keys()]).toEqual([building.uid, 1200]);
    push(target, 255, []);
    expect(target.appearances.size).toBe(0);
  });

  it('starts a new appearance timeline when the engine logic frame rewinds', () => {
    const target = view();
    push(target, 100);
    const before = target.visualFor(building, -1, 100);
    push(target, 150);
    push(target, 10);
    const after = target.visualFor(building, -1, 10);
    expect(after).toBe(before);
    expect(after.firstFrame).toBe(10);
    expect(target.appearances.get(building.uid)).toEqual({ frame: 10, afterGap: false, lastSeen: 10 });
    expect(target.buildupFrame(building, after, 10)).toBeNull();
    push(target, 60);
    const replacement = { ...building, uid: building.uid + 1 };
    push(target, 110, [building, replacement]);
    const visual = target.visualFor(replacement, -1, 110);
    expect(target.buildupFrame(replacement, visual, 110)).toBe(0);
  });
});

const infantry: LiveObject = { ...building, kind: 'infantry', type: 'TEST_INFANTRY' };
const sequences: Record<string, InfantrySequence> = {
  Ready: { start: 0, count: 1, facingMultiplier: 1 },
  Walk: { start: 8, count: 6, facingMultiplier: 6 },
  FireUp: { start: 56, count: 3, facingMultiplier: 3 },
  FireProne: { start: 80, count: 3, facingMultiplier: 3 },
  Prone: { start: 104, count: 1, facingMultiplier: 1 },
  Crawl: { start: 112, count: 4, facingMultiplier: 4 },
  Die1: { start: 144, count: 7, facingMultiplier: 0 },
  Deploy: { start: 151, count: 9, facingMultiplier: 0 },
  Deployed: { start: 160, count: 1, facingMultiplier: 1 },
  Idle1: { start: 168, count: 5, facingMultiplier: 0 },
  Idle2: { start: 173, count: 6, facingMultiplier: 0 },
  Cheer: { start: 179, count: 8, facingMultiplier: 0 },
  Paradrop: { start: 187, count: 1, facingMultiplier: 1 },
  Panic: { start: 195, count: 6, facingMultiplier: 6 },
};

function infantryView(metadata: Record<string, InfantrySequence> | null = sequences) {
  const frames: SpriteFrame[] = Array.from({ length: 256 }, (_, frame) => ({
    rect: [frame, 0, 1, 1],
    offset: [0, 0],
  }));
  const type: LibraryType = {
    kind: 'infantry',
    image: 'TEST_INFANTRY',
    sprite: 'infantry',
    drawOffset: [0, 0],
    lighting: 'ambient',
    remap: true,
    ...(metadata ? { infantry: { sequenceName: 'TestSequence', sequences: metadata } } : {}),
  };
  const target = Object.assign(Object.create(LiveView.prototype), {
    world: { terrain: { heightAt: () => 0 } },
    library: {
      library: { sprites: { infantry: { frames, palette: 'unit', remap: false } } },
      page: () => ({}),
    },
    spritePool: new SpritePool(),
    libraryPalette: (palette: string) => palette,
  }) as ViewState;
  const visual: VisualState = { firstFrame: 0, libraryType: type, paletteKey: '' };
  return {
    visual,
    draw(object: LiveObject, facing = 0, frame = 100): number {
      const batch = new Map<number, SpriteInstance[]>();
      target.libraryInfantrySprites(object, { x: 0, y: 0, z: 0, facing }, visual, batch, frame);
      const drawn = batch.get(0)?.[0]?.frame;
      return drawn ? frames.indexOf(drawn) : -1;
    },
  };
}

describe('infantry engine sequences', () => {
  it('draws the native death step with health zero and holds it while renderer time advances', () => {
    const target = infantryView();
    const dying = { ...infantry, health: 0, infantrySequence: 'Die1', sequenceFrame: 2 };
    target.visual.lastMoveFrame = target.visual.firedFrame = 100;
    expect(target.draw(dying, 0, 100)).toBe(sequences.Die1!.start + 2);
    expect(target.draw(dying, 0, 9000)).toBe(sequences.Die1!.start + 2);
  });
  it('uses the engine draw facing for target-directed frames, including zero and sector boundaries', () => {
    const target = infantryView({ FireFly: { start: 8, count: 6, facingMultiplier: 6 } });
    const native = { ...infantry, infantrySequence: 'FireFly', sequenceFrame: 2 };
    expect(target.draw({ ...native, infantryDrawFacingRaw: 0x3fff })).toBe(8 + 5 * 6 + 2);
    expect(target.draw({ ...native, infantryDrawFacingRaw: 0 }, Math.PI / 2)).toBe(8 + 7 * 6 + 2);
    expect(target.draw({ ...native, infantryDrawFacingRaw: 3071 })).toBe(8 + 7 * 6 + 2);
    expect(target.draw({ ...native, infantryDrawFacingRaw: 3072 })).toBe(8 + 6 * 6 + 2);
    // Older snapshots still use the interpolated travel pose.
    expect(target.draw(native)).toBe(8 + 7 * 6 + 2);
  });
  it('preserves raw-facing boundaries instead of rounding the pose to a byte direction', () => {
    const target = infantryView();
    const native = { ...infantry, infantrySequence: 'Walk', sequenceFrame: 2 };
    const pose = (raw: number) => (raw / 65536) * Math.PI * 2;
    expect(target.draw(native, pose(3071))).toBe(8 + 7 * 6 + 2);
    expect(target.draw(native, pose(3072))).toBe(8 + 6 * 6 + 2);
    expect(target.draw(native, pose(11263))).toBe(8 + 6 * 6 + 2);
    expect(target.draw(native, pose(11264))).toBe(8 + 5 * 6 + 2);
    target.visual.lastMoveFrame = 100;
    expect(target.draw(infantry, pose(3072))).toBe(8 + 6 * 6 + (50 % 6));
    target.visual.firedFrame = 99;
    expect(target.draw(infantry, pose(3072))).toBe(56 + 6 * 3 + 1);
  });

  it('draws every named sequence using its library start, facing multiplier and engine-local step', () => {
    const target = infantryView();
    const facing = Math.PI / 2;
    const direction = facingFrame(64, 8);
    for (const [name, sequence] of Object.entries(sequences)) {
      const step = sequence.count + 2;
      expect(target.draw({ ...infantry, infantrySequence: name, sequenceFrame: step }, facing)).toBe(
        sequence.start + direction * sequence.facingMultiplier + (step % sequence.count),
      );
    }
  });

  it('lets an explicit prone/firing/deploy/death sequence take precedence over inferred motion and shots', () => {
    const target = infantryView();
    target.visual.lastMoveFrame = 100;
    target.visual.firedFrame = 100;
    target.visual.deadFrame = 100;
    for (const name of ['FireProne', 'Prone', 'Crawl', 'Deploy', 'Deployed', 'Die1']) {
      const sequence = sequences[name]!;
      expect(target.draw({ ...infantry, infantrySequence: name, sequenceFrame: 0 })).toBe(
        sequence.start + facingFrame(0, 8) * sequence.facingMultiplier,
      );
    }
  });

  it('uses the first sequence step when the host has a sequence name without progress', () => {
    const target = infantryView();
    expect(target.draw({ ...infantry, infantrySequence: 'Deploy' })).toBe(sequences.Deploy!.start);
  });

  it('preserves walk, fire and clamped death fallbacks when a cache lacks the reported sequence', () => {
    const target = infantryView();
    const unknown = { ...infantry, infantrySequence: 'NewSequence', sequenceFrame: 50 };
    expect(target.draw(unknown)).toBe(facingFrame(0, 8));
    target.visual.lastMoveFrame = 100;
    expect(target.draw(unknown)).toBe(8 + facingFrame(0, 8) * 6 + (50 % 6));
    target.visual.firedFrame = 99;
    expect(target.draw(unknown)).toBe(56 + facingFrame(0, 8) * 3 + 1);
    target.visual.deadFrame = 90;
    expect(target.draw(unknown)).toBe(149);
    expect(target.draw(unknown, 0, 110)).toBe(150);
  });

  it('draws Guard-only metadata and a legacy body without any sequence metadata', () => {
    const guard = infantryView({ Guard: { start: 5, count: 1, facingMultiplier: 1 } });
    expect(guard.draw(infantry)).toBe(5 + facingFrame(0, 8));
    const legacy = infantryView(null);
    expect(legacy.draw({ ...infantry, infantrySequence: 'Prone', sequenceFrame: 8 })).toBe(0);
  });
});

describe('native building body selection', () => {
  it('uses frame zero below yellow and occupancy frames while keeping damaged bib art independent', () => {
    const frames: SpriteFrame[] = Array.from({ length: 4 }, (_, i) => ({ rect: [i, 0, 1, 1], offset: [0, 0] }));
    const bib = frames.map((f) => ({ ...f, rect: [10 + f.rect[0], 0, 1, 1] as [number, number, number, number] }));
    const type: LibraryType = { ...buildingType, building: { bodyFrames: 4, layers: [], bib: 'bib' } };
    const target = Object.assign(Object.create(LiveView.prototype), {
      cache: { depthTemplate: undefined },
      library: {
        conditionYellow: 0.5,
        library: {
          sprites: {
            body: { frames, remap: true },
            bib: { frames: bib, remap: true },
          },
        },
        page: () => ({}),
      },
      spritePool: new SpritePool(),
      civilian: new Set(),
      buildingPalette: () => 'test',
      buildupFrame: () => null,
      nativeBuildingAnims: () => null,
    });
    for (const nativeFrame of [0, 1, 2, 3]) {
      const batch = new Map<number, SpriteInstance[]>();
      const object = { ...building, health: 0.475, buildingFrame: nativeFrame, buildingDamaged: true };
      target.libraryBuildingSprites(object, { libraryType: type, paletteKey: '' }, batch, { frame: 1 });
      expect(batch.get(0)!.map((s) => s.frame)).toEqual([bib[1], frames[nativeFrame]]);
    }
  });
});
