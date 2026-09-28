/** Manual synthetic 4096-square page benchmark, including a spawned nearest-4x binary and final PNG writes. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpriteEntry, SpriteFrame } from '../src/manifest.ts';
import { encodePng } from '../src/node/png.ts';
import { upscaleSprites } from '../src/node/spriteHdCache.ts';
import { fakeNearestBinary, spriteEntry, spriteFrame, spritePalette } from './spriteHdFixtures.ts';

const root = mkdtempSync(join(tmpdir(), 'ra2-sprite-benchmark-'));
try {
  const dir = join(root, '_library', 'temperate');
  mkdirSync(dir, { recursive: true });
  const width = 4096;
  const data = new Uint8Array(width * width);
  const bodies: SpriteFrame[] = [];
  const shadows: SpriteFrame[] = [];
  // 1,800 varied body frames and 1,800 separate shadow frames, each 64x64 in a 68px cell.
  for (let row = 0; row < 60; row++) {
    for (let col = 0; col < 60; col++) {
      const x = col * 68 + 2;
      const y = row * 68 + 2;
      const shadow = row % 2 === 1;
      (shadow ? shadows : bodies).push(spriteFrame([x, y, 64, 64]));
      for (let py = 0; py < 64; py++) {
        for (let px = 0; px < 64; px++) {
          if ((px - 32) ** 2 + (py - 32) ** 2 > 30 ** 2) continue;
          data[(y + py) * width + x + px] = shadow ? 1 : 1 + ((px * 3 + py * 7 + row * 11 + col * 13) % 255);
        }
      }
    }
  }
  const sprites: Record<string, SpriteEntry> = { synthetic: spriteEntry(bodies, { shadows, remap: true }) };
  writeFileSync(join(dir, 'sprites-0.png'), encodePng({ width, height: width, channels: 1, data }));
  writeFileSync(join(dir, 'unit.png'), encodePng(spritePalette()));
  writeFileSync(
    join(dir, 'library.json'),
    JSON.stringify({
      version: 1,
      theater: 'temperate',
      spriteAtlases: [{ file: 'sprites-0.png', width, height: width }],
      palettes: { unit: 'unit.png' },
      sprites,
    }),
  );
  console.log(
    `Synthetic page ready: ${width}x${width}, ${bodies.length} body + ${shadows.length} shadow frames; Node ${process.version}`,
  );
  const results = await upscaleSprites({
    cacheDir: root,
    library: 'temperate',
    pages: [0],
    bin: fakeNearestBinary(root),
  });
  console.log(JSON.stringify(results[0], null, 2));
  console.log('Fake binary measures PNG/process/CPU overhead only; actual model inference remains unverified.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
