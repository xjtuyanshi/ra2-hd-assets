import { describe, expect, it } from 'vitest';
import { idFromName } from './crc.js';
import { MIX_FLAG_CHECKSUM, MixFile } from './mixFile.js';
import { Vfs } from './vfs.js';

interface SynthEntry {
  name: string;
  data: Uint8Array;
}

function buildPlainMix(entries: SynthEntry[], checksum = false): Uint8Array {
  const cbIndex = entries.length * 12;
  const bodySize = entries.reduce((n, e) => n + e.data.length, 0);
  const total = 4 + 6 + cbIndex + bodySize + (checksum ? 20 : 0);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint32(0, checksum ? MIX_FLAG_CHECKSUM : 0, true);
  view.setUint16(4, entries.length, true);
  view.setInt32(6, bodySize, true);
  let indexP = 10;
  let bodyOffset = 0;
  const bodyBase = 10 + cbIndex;
  for (const e of entries) {
    view.setUint32(indexP, idFromName(e.name) >>> 0, true);
    view.setInt32(indexP + 4, bodyOffset, true);
    view.setInt32(indexP + 8, e.data.length, true);
    buf.set(e.data, bodyBase + bodyOffset);
    indexP += 12;
    bodyOffset += e.data.length;
  }
  return buf;
}

const str = (s: string): Uint8Array => new TextEncoder().encode(s);
const asStr = (u: Uint8Array | undefined): string | undefined =>
  u ? new TextDecoder().decode(u) : undefined;

describe('Vfs', () => {
  it('resolves files from a single mount', () => {
    const vfs = new Vfs();
    vfs.mountData(buildPlainMix([{ name: 'rules.ini', data: str('base-rules') }]));
    expect(asStr(vfs.openFile('rules.ini'))).toBe('base-rules');
    expect(vfs.exists('rules.ini')).toBe(true);
    expect(vfs.openFile('missing.ini')).toBeUndefined();
    expect(vfs.exists('missing.ini')).toBe(false);
  });

  it('gives later mounts precedence over earlier ones', () => {
    const vfs = new Vfs();
    vfs.mountData(
      buildPlainMix([
        { name: 'rules.ini', data: str('base-rules') },
        { name: 'only-base.ini', data: str('base-only') },
      ]),
    );
    vfs.mountData(buildPlainMix([{ name: 'rules.ini', data: str('expansion-rules') }]));

    // Shadowed by the later mount.
    expect(asStr(vfs.openFile('rules.ini'))).toBe('expansion-rules');
    // Not present in later mount, falls through to the base.
    expect(asStr(vfs.openFile('only-base.ini'))).toBe('base-only');
    expect(vfs.mountCount).toBe(2);
  });

  it('mounts a MIX nested inside another MIX', () => {
    const inner = buildPlainMix([{ name: 'rulesmd.ini', data: str('nested-rules') }]);
    const outer = MixFile.parse(buildPlainMix([{ name: 'localmd.mix', data: inner }]));

    const vfs = new Vfs();
    vfs.mount(outer);
    // Before mounting the nested archive, its inner files are not visible.
    expect(vfs.openFile('rulesmd.ini')).toBeUndefined();

    const mounted = vfs.mountNested(outer, 'localmd.mix');
    expect(mounted).toBeDefined();
    expect(asStr(vfs.openFile('rulesmd.ini'))).toBe('nested-rules');
  });

  it('returns undefined when mounting a nonexistent nested MIX', () => {
    const outer = MixFile.parse(buildPlainMix([{ name: 'a.mix', data: str('x') }]));
    const vfs = new Vfs();
    vfs.mount(outer);
    expect(vfs.mountNested(outer, 'notthere.mix')).toBeUndefined();
  });

  it('models the RA2/YR load order (last mounted wins)', () => {
    const vfs = new Vfs();
    // ra2.mix (oldest) -> ra2md.mix -> expandmd01.mix (newest).
    vfs.mountData(buildPlainMix([{ name: 'rulesmd.ini', data: str('v-ra2') }]));
    vfs.mountData(buildPlainMix([{ name: 'rulesmd.ini', data: str('v-ra2md') }]));
    vfs.mountData(buildPlainMix([{ name: 'rulesmd.ini', data: str('v-expand') }]));
    expect(asStr(vfs.openFile('rulesmd.ini'))).toBe('v-expand');
  });
});
