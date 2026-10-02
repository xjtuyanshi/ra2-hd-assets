/** Asset-free CPU/upload comparison. Run with pnpm exec node --import tsx packages/hd-renderer/benchmarks/effectBuffers.mts. */
import { performance } from 'node:perf_hooks';
import { DataTexture, InstancedBufferAttribute, Vector3 } from 'three/webgpu';
import { BeamSegmentBuffer, beamSegments, type BeamSpec } from '../src/effects.ts';
import { EffectSpriteLayer, type EffectInstance } from '../src/live/effectSprites.ts';
import type { Ra2Cache } from '../src/ra2/cache.ts';

function medianMs(run: () => void, iterations: number): number {
  for (let i = 0; i < 5; i++) run();
  const batches: number[] = [];
  for (let batch = 0; batch < 7; batch++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) run();
    batches.push((performance.now() - start) / iterations);
  }
  return batches.sort((a, b) => a - b)[3]!;
}

let beams: BeamSpec[] = [];
const beamBuffer = new BeamSegmentBuffer();
const legacyBeamAttributes = [0, 1, 2].map(() => new InstancedBufferAttribute(new Float32Array(4096 * 3), 3));
let constructedSegments = 0;
const legacyBeams = () => {
  const segments: [Vector3, Vector3, Vector3][] = [];
  const white = new Vector3(1, 1, 1);
  for (const beam of beams) {
    const pieces = beamSegments(beam.from, beam.to, beam.bolt, beam.seed);
    const perStrand = pieces.length / 3;
    pieces.forEach(([a, b], i) => segments.push([a, b, i < perStrand ? white : beam.colour]));
  }
  constructedSegments = segments.length;
  for (let i = 0; i < Math.min(4096, segments.length); i++)
    for (let a = 0; a < 3; a++) {
      const vector = segments[i]![a]!;
      legacyBeamAttributes[a]!.setXYZ(i, vector.x, vector.y, vector.z);
    }
};
const optimizedBeams = () => {
  beamBuffer.set(beams);
  beamBuffer.flush();
  beamBuffer.from.clearUpdateRanges();
  beamBuffer.to.clearUpdateRanges();
  beamBuffer.colour.clearUpdateRanges();
};

function measureBeams(count: number, length: number) {
  beams = Array.from({ length: count }, (_, i) => ({
    from: new Vector3(i / 10, 0, i / 20),
    to: new Vector3(length + i / 10, 1, i / 20),
    colour: new Vector3(0.12, 0.34, 0.9),
    bolt: true,
    seed: i * 7919,
  }));
  const beforeMs = medianMs(() => {
    for (const beam of beams) beam.seed += 7919;
    legacyBeams();
  }, 20);
  const afterMs = medianMs(() => {
    for (const beam of beams) beam.seed += 7919;
    optimizedBeams();
  }, 100);
  return {
    count,
    length,
    beforeMs,
    afterMs,
    speedup: beforeMs / afterMs,
    beforeConstructedSegments: constructedSegments,
    afterConstructedSegments: beamBuffer.count,
  };
}

const cards: EffectInstance[] = Array.from({ length: 1024 }, (_, i) => ({
  anchor: new Vector3(i / 10, 0.1, 1),
  frame: { rect: [0, 0, 8, 8], offset: [-4, -4], page: i % 4 },
  palette: 'fx:anim',
  alpha: 1,
  push: 0.1,
  draw: 'card',
  pass: 'air',
  depth: 1024 - i,
  glow: false,
}));
const cache = {
  paletteAtlas: { image: { height: 4 } },
  paletteRow: new Map([['fx:anim', 1]]),
} as unknown as Ra2Cache;
const layer = new EffectSpriteLayer(cache, () => ({ texture: new DataTexture(), width: 64, height: 64 }));
layer.setInstances(cards, 0);
const pages = (
  layer as unknown as {
    meshes: Map<
      string,
      {
        anchor: InstancedBufferAttribute;
        rect: InstancedBufferAttribute;
        params: InstancedBufferAttribute;
        style: InstancedBufferAttribute;
      }
    >;
  }
).meshes;
const optimizedAttributes = [...pages.values()].flatMap((page) => [page.anchor, page.rect, page.params, page.style]);
const legacyPages = new Map<string, InstancedBufferAttribute[]>();
for (let page = 0; page < 4; page++)
  legacyPages.set(
    `${page}:air`,
    [3, 4, 4, 4].map((size) => new InstancedBufferAttribute(new Float32Array(4096 * size), size)),
  );
let legacyBytes = 0;
const legacyCards = () => {
  const groups = new Map<string, EffectInstance[]>();
  for (const instance of cards) {
    const key = `${instance.frame.page ?? 0}:${instance.pass}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(instance);
  }
  legacyBytes = 0;
  for (const [key, list] of groups) {
    const [anchor, rect, params, style] = legacyPages.get(key)!;
    const rank = (s: EffectInstance) => (s.draw === 'flat' ? 0 : s.draw === 'shadow' ? 1 : 2);
    const ordered = [...list].sort((a, b) => rank(a) - rank(b) || a.depth - b.depth).slice(0, 4096);
    ordered.forEach((s, i) => {
      anchor!.setXYZ(i, s.anchor.x, s.anchor.y, s.anchor.z);
      rect!.setXYZW(i, ...s.frame.rect);
      params!.setXYZW(i, ...s.frame.offset, cache.paletteRow.get(s.palette) ?? 0, s.push);
      style!.setXYZW(i, s.alpha, s.draw === 'shadow' ? 2 : s.draw === 'flat' ? 1 : 0, s.glow ? 1 : 0, 0);
    });
    for (const attribute of legacyPages.get(key)!) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, ordered.length * attribute.itemSize);
      attribute.needsUpdate = true;
      legacyBytes += ordered.length * attribute.itemSize * 4;
    }
  }
};
const clearUploads = () => {
  for (const attribute of optimizedAttributes) attribute.clearUpdateRanges();
};
const uploadBytes = () =>
  optimizedAttributes.reduce(
    (total, attribute) => total + attribute.updateRanges.reduce((bytes, range) => bytes + range.count * 4, 0),
    0,
  );
const optimizedCards = () => {
  clearUploads();
  layer.setInstances(cards, 0);
};

const beamResults = [measureBeams(16, 12), measureBeams(64, 100)];
const beforeCards = medianMs(legacyCards, 100);
const afterCards = medianMs(optimizedCards, 100);
clearUploads();
layer.setInstances(cards, 0);
const unchangedBytes = uploadBytes();
clearUploads();
cards[512]!.anchor.y += 0.25;
layer.setInstances(cards, 0);
console.log(
  JSON.stringify(
    {
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      beams: beamResults,
      cards: {
        count: cards.length,
        pages: 4,
        beforeMs: beforeCards,
        afterMs: afterCards,
        speedup: beforeCards / afterCards,
        beforeBytesPerCall: legacyBytes,
        afterUnchangedBytes: unchangedBytes,
        afterOneCoordinateChangedBytes: uploadBytes(),
      },
    },
    null,
    2,
  ),
);
