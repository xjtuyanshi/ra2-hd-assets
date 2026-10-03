/** Inventory player-supplied scenarios without writing into the installation. */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MapFile, MixFile, idFromName, parseIni } from '../../packages/ra2-formats/src/index.js';

const { values } = parseArgs({ options: { game: { type: 'string' }, out: { type: 'string' } } });
if (!values.game || !values.out) throw new Error('--game and --out are required');
const game = resolve(values.game);
const out = resolve(values.out);
if (out === game || out.startsWith(`${game}/`)) throw new Error('Output must be outside the installation');
const sources = join(out, '_sources');
mkdirSync(sources, { recursive: true });
const decoder = new TextDecoder('latin1');
const names = new Map<number, string>();
const listed = new Set<string>();
const candidates: { bytes: Uint8Array; source: string; entryId: number; looseName?: string }[] = [];
const errors: { source: string; error: string }[] = [];
const archives: { source: string; entries: number }[] = [];

function inspect(bytes: Uint8Array, source: string, entryId: number, looseName?: string): void {
  if (bytes.length > 4 * 1024 ** 2) return;
  const prefix = decoder.decode(bytes.subarray(0, 256));
  if (!/^(?:\s|;[^\n]*\n)*\[/.test(prefix)) return;
  const text = decoder.decode(bytes);
  if (/^\[MultiMaps\]/im.test(text)) {
    const ini = parseIni(text);
    for (const name of [
      ...ini.sectionNames().filter((name) => name.toLowerCase() !== 'multimaps'),
      ...(ini.getSection('MultiMaps')?.entries.map((entry) => entry.value) ?? []),
    ]) {
      const filename = /\.(map|mpr|yrm)$/i.test(name) ? name : `${name}.map`;
      names.set(idFromName(filename), filename);
      listed.add(name.replace(/\.(map|mpr|yrm)$/i, '').toLowerCase());
    }
  }
  if (/^\[Map\]/im.test(text) && /^\[IsoMapPack5\]/im.test(text))
    candidates.push({ bytes, source, entryId, ...(looseName ? { looseName } : {}) });
}

function scan(mix: MixFile, source: string, depth = 0): void {
  archives.push({ source, entries: mix.count });
  for (const entry of mix.list()) {
    const bytes = mix.readById(entry.id)!;
    const label = `${source}/0x${entry.id.toString(16).padStart(8, '0')}`;
    inspect(bytes, label, entry.id);
    if (depth >= 4 || bytes.length < 10) continue;
    const flags = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    if (![0, 0x10000, 0x20000, 0x30000].includes(flags)) continue;
    // Binary art often begins with zero; validate a plain MIX header before parsing it.
    if (!(flags & 0x20000)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, 10);
      const expected = 10 + view.getUint16(4, true) * 12 + view.getInt32(6, true) + (flags & 0x10000 ? 20 : 0);
      if (expected !== bytes.length) continue;
    }
    try {
      scan(MixFile.parse(bytes), label, depth + 1);
    } catch {
      // Non-archive binary members are not missing resources or scenario failures.
    }
  }
}

for (const file of readdirSync(game).sort()) {
  const path = join(game, file);
  if (/\.mix$/i.test(file)) {
    try {
      scan(MixFile.parse(readFileSync(path)), file);
    } catch (error) {
      errors.push({ source: file, error: String(error) });
    }
  } else if (/\.(map|mpr|yrm)$/i.test(file)) {
    names.set(idFromName(file), file);
    inspect(readFileSync(path), file, idFromName(file), file);
  } else if (/\.(mmx|yro)$/i.test(file)) {
    try {
      scan(MixFile.parse(readFileSync(path)), file);
      const mapName = `${basename(file, extname(file))}.map`;
      names.set(idFromName(mapName), mapName);
    } catch {
      try {
        const bytes = readFileSync(path);
        const text = decoder.decode(bytes);
        const first = /(^|\n)\s*\[/.exec(text);
        if (!first) throw new Error('No INI start');
        MapFile.parse(text.slice(first.index));
        const mapName = `${basename(file, extname(file))}.map`;
        inspect(Buffer.from(text.slice(first.index), 'latin1'), file, idFromName(mapName), mapName);
      } catch (error) {
        errors.push({ source: file, error: String(error) });
      }
    }
  }
}

const maps: Record<string, unknown>[] = [];
const seen = new Map<string, string>();
const excluded: { source: string; reason: string }[] = [];
for (const candidate of candidates) {
  const map = MapFile.parse(candidate.bytes);
  const file = candidate.looseName ?? names.get(candidate.entryId) ?? `archived_${candidate.entryId.toString(16)}.map`;
  let id = basename(file, extname(file));
  const basic = map.ini.getSection('Basic');
  const size = map.size;
  if (!basic?.getBool('MultiplayerOnly') && !listed.has(id.toLowerCase())) {
    excluded.push({ source: candidate.source, reason: 'Not marked or indexed as multiplayer' });
    continue;
  }
  if (!size) {
    errors.push({ source: candidate.source, error: 'Multiplayer scenario has no Map Size' });
    continue;
  }
  const sha256 = createHash('sha256').update(candidate.bytes).digest('hex');
  const existing = seen.get(id.toLowerCase());
  if (existing === sha256) {
    const original = maps.find((item) => String(item.id).toLowerCase() === id.toLowerCase())!;
    (original.duplicateSources as string[]).push(candidate.source);
    continue;
  }
  if (existing) id += `__${sha256.slice(0, 8)}`;
  seen.set(id.toLowerCase(), sha256);
  const input = join(sources, `${id}.map`);
  writeFileSync(input, candidate.bytes);
  maps.push({
    id,
    input,
    source: candidate.source,
    sha256,
    duplicateSources: [],
    displayName: basic?.getString('Name'),
    theater: map.theater.toLowerCase(),
    size,
    status: 'pending',
    elapsedSeconds: 0,
    errors: [],
    outputBytes: 0,
  });
}
maps.sort((a, b) => String(a.id).localeCompare(String(b.id)));
writeFileSync(
  join(out, 'INVENTORY.json'),
  JSON.stringify(
    {
      version: 1,
      game,
      createdAt: new Date().toISOString(),
      archives,
      errors,
      excluded,
      maps,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ maps: maps.length, archives: archives.length, errors, excluded: excluded.length }));
