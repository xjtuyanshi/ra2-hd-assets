/** Private, headless archive evidence collector. Inputs/outputs are caller-owned and stay outside Git. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MixFile } from '../../packages/ra2-formats/src/mix/mixFile.js';
import { crc32, idFromName } from '../../packages/ra2-formats/src/mix/crc.js';

interface Source {
  kind: 'loose-mix' | 'package-mix';
  path: string;
  member?: string;
  expected_bytes: number;
  package_list_exit?: number;
  package_type?: string;
  expected_crc?: string;
}
interface IndexEntry {
  id: number;
  offset: number;
  size: number;
}
interface ScanNode {
  path: string;
  sha256: string;
  bytes: number;
  format: string;
  encrypted: boolean;
  checksum: boolean;
  depth: number;
  entries: IndexEntry[];
  targets: { name: string; id: string; size: number; extracted: string; sha256: string }[];
  positive_controls: { name: string; id: string; size: number; sha256: string }[];
  probes: { id: string; names: string[]; size: number; flags: string; result: string; error?: string }[];
}
interface ScanResult {
  source: Source;
  state: string;
  bytes?: number;
  sha256?: string;
  nodes: ScanNode[];
  errors: string[];
}
const [manifestFile, outputArg] = process.argv.slice(2);
if (!manifestFile || !outputArg) throw new Error('Usage: tsx auditSuppliedCameos.mts MANIFEST OUT');
const output = resolve(outputArg);
mkdirSync(join(output, 'extracted'), { recursive: true });
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
  sources: Source[];
  known_mix_name_hints: string[];
  stems: string[];
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hex = (value: number) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
const targets = manifest.stems.flatMap((stem) =>
  ['shp', 'pcx'].map((ext) => {
    const name = `${stem}.${ext}`;
    if (idFromName(name) !== idFromName(name.toUpperCase())) throw new Error(`Case normalization failed: ${name}`);
    return { name, id: idFromName(name), variants: [name, name.toUpperCase(), `${stem.toUpperCase()}.${ext}`] };
  }),
);
const nameHints = new Map<number, string[]>();
const controls = ['e1icon.shp', 'engiicon.shp', 'xxicon.shp', 'yconicon.shp'].map((name) => ({
  name,
  id: idFromName(name),
}));
for (const name of manifest.known_mix_name_hints) {
  const id = idFromName(name);
  nameHints.set(id, [...(nameHints.get(id) ?? []), name]);
}

function parseStrict(bytes: Uint8Array) {
  const mix = MixFile.parse(bytes),
    entries = mix.list();
  const bodyStart = mix.encrypted ? 92 + ((entries.length * 12 + 5) & ~7) : 10 + entries.length * 12;
  const bodyEnd = bytes.length - (mix.checksum ? 20 : 0);
  for (const entry of entries) {
    if (entry.size < 0 || entry.offset < bodyStart || entry.offset + entry.size > bodyEnd) {
      throw new Error(`MIX index member ${hex(entry.id)} is outside body bounds`);
    }
  }
  return { entries, encrypted: mix.encrypted, checksum: mix.checksum, format: 'RA2 flagged MIX' };
}

// A strict size/index check catches older headerless containers without assuming they are RA2 flagged MIXes.
function parseLegacy(bytes: Uint8Array) {
  if (bytes.length < 6) throw new Error('Legacy MIX header truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(0, true),
    bodySize = view.getUint32(2, true),
    bodyStart = 6 + count * 12;
  if (!count || bodyStart + bodySize !== bytes.length) throw new Error('Not a strict headerless MIX');
  const entries: IndexEntry[] = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    const id = view.getUint32(p, true),
      offset = bodyStart + view.getUint32(p + 4, true),
      size = view.getUint32(p + 8, true);
    if (offset < bodyStart || offset + size > bytes.length)
      throw new Error('Legacy MIX index member outside body bounds');
    entries.push({ id, offset, size });
  }
  return { entries, encrypted: false, checksum: false, format: 'legacy headerless MIX' };
}

function scan(bytes: Uint8Array, path: string, depth: number, result: ScanResult, parentHashes: Set<string>) {
  if (depth > 64) throw new Error('Nested archive depth exceeds safety limit');
  const digest = hash(bytes);
  if (parentHashes.has(digest)) throw new Error('Nested archive repeats ancestor bytes');
  let parsed;
  try {
    parsed = parseStrict(bytes);
  } catch (flaggedError) {
    try {
      parsed = parseLegacy(bytes);
    } catch {
      throw flaggedError;
    }
  }
  const node: ScanNode = {
    path,
    sha256: digest,
    bytes: bytes.length,
    ...parsed,
    depth,
    targets: [],
    positive_controls: [],
    probes: [],
  };
  result.nodes.push(node);
  for (const control of controls) {
    for (const entry of node.entries.filter((entry) => entry.id === control.id)) {
      node.positive_controls.push({
        name: control.name,
        id: hex(control.id),
        size: entry.size,
        sha256: hash(bytes.subarray(entry.offset, entry.offset + entry.size)),
      });
    }
  }
  for (const target of targets) {
    // Inspect every matching entry, including duplicate IDs; no VFS mount precedence is applied.
    for (const entry of node.entries.filter((entry) => entry.id === target.id)) {
      const art = bytes.subarray(entry.offset, entry.offset + entry.size),
        artHash = hash(art);
      const file = `${target.name.replace('.', '-')}-${artHash.slice(0, 16)}.${target.name.split('.').at(-1)}`;
      if (!existsSync(join(output, 'extracted', file))) writeFileSync(join(output, 'extracted', file), art);
      node.targets.push({
        name: target.name,
        id: hex(target.id),
        size: entry.size,
        extracted: `extracted/${file}`,
        sha256: artHash,
      });
    }
  }
  const ancestors = new Set([...parentHashes, digest]);
  for (const entry of node.entries) {
    if (entry.size < 6) continue;
    const member = bytes.subarray(entry.offset, entry.offset + entry.size);
    const flags = new DataView(member.buffer, member.byteOffset, member.byteLength).getUint32(0, true);
    const names = nameHints.get(entry.id) ?? [];
    // Every body member receives the plain/encrypted flag and legacy shape check, including unnamed members.
    const flaggedCandidate = (flags & ~0x00030000) === 0;
    let legacyCandidate = false;
    if (!flaggedCandidate) {
      const view = new DataView(member.buffer, member.byteOffset, member.byteLength);
      const count = view.getUint16(0, true);
      legacyCandidate = count > 0 && 6 + count * 12 + view.getUint32(2, true) === member.length;
    }
    if (!flaggedCandidate && !legacyCandidate && !names.length) continue;
    const probe: ScanNode['probes'][number] = {
      id: hex(entry.id),
      names,
      size: entry.size,
      flags: hex(flags),
      result: 'pending',
    };
    node.probes.push(probe);
    try {
      scan(
        member,
        `${path}!${hex(entry.id)}${names.length ? `(${names.join('|')})` : ''}`,
        depth + 1,
        result,
        ancestors,
      );
      probe.result = 'nested MIX parsed';
    } catch (error) {
      probe.result = names.length ? 'named MIX unreadable' : 'rejected structural candidate';
      probe.error = error instanceof Error ? error.message : String(error);
      if (names.length) result.errors.push(`${path}!${probe.id} ${names.join('|')}: ${probe.error}`);
    }
  }
}

const priorFile = join(output, 'archive-search.json');
const results = existsSync(priorFile) ? (JSON.parse(readFileSync(priorFile, 'utf8')).sources as ScanResult[]) : [];
function save() {
  const nodes = results.flatMap((result) => result.nodes);
  const summary = {
    top_level_total: manifest.sources.length,
    top_level_done: results.length,
    parsed_sources: results.filter((result) => result.nodes.length > 0).length,
    mix_occurrences: nodes.length,
    nested_mix_occurrences: nodes.filter((node) => node.depth > 0).length,
    unique_mix_sha256: new Set(nodes.map((node) => node.sha256)).size,
    member_index_occurrences: nodes.reduce((sum, node) => sum + node.entries.length, 0),
    unique_members_by_mix_sha256: [...new Map(nodes.map((node) => [node.sha256, node])).values()].reduce(
      (sum, node) => sum + node.entries.length,
      0,
    ),
    target_hits: nodes.reduce((sum, node) => sum + node.targets.length, 0),
    top_level_errors: results.filter((result) => result.state === 'failed').length,
    named_nested_errors: nodes.reduce(
      (sum, node) => sum + node.probes.filter((probe) => probe.result === 'named MIX unreadable').length,
      0,
    ),
    outer_extraction_errors: results.reduce(
      (sum, result) => sum + result.errors.filter((error) => error.startsWith('Outer extraction exit')).length,
      0,
    ),
    rejected_structural_candidates: nodes.reduce(
      (sum, node) => sum + node.probes.filter((probe) => probe.result === 'rejected structural candidate').length,
      0,
    ),
    legacy_mix_occurrences: nodes.filter((node) => node.format.includes('legacy')).length,
    positive_control_occurrences: nodes.reduce((sum, node) => sum + node.positive_controls.length, 0),
  };
  writeFileSync(
    priorFile,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        manifest: resolve(manifestFile),
        targets: targets.map((target) => ({ ...target, id: hex(target.id) })),
        summary,
        sources: results,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(output, 'progress.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

for (const source of manifest.sources) {
  if (results.some((result) => JSON.stringify(result.source) === JSON.stringify(source))) continue;
  if (loadavg()[0]! > 30) {
    console.log('PARKED: one-minute load is above 30');
    save();
    process.exit(3);
  }
  const result: ScanResult = { source, state: 'pending', nodes: [], errors: [] };
  try {
    let bytes: Uint8Array;
    if (source.kind === 'loose-mix') bytes = readFileSync(source.path);
    else {
      const rar = source.package_type?.startsWith('Rar');
      const extractor = rar ? '/usr/bin/bsdtar' : '/opt/homebrew/bin/7zz';
      const args = rar ? ['-xOf', source.path, source.member!] : ['x', '-so', source.path, source.member!];
      const child = spawnSync(extractor, args, { maxBuffer: 1024 * 1024 * 1024 });
      // A partial outer archive returns 2 even for an intact recovered member; preserve that extraction status.
      writeFileSync(
        join(output, `stream-${results.length + 1}.log`),
        `extractor=${extractor}\nexit=${child.status}\n${child.stderr?.toString() ?? ''}\n${child.error?.message ?? ''}`,
      );
      bytes = child.stdout;
      if (child.status !== 0)
        result.errors.push(
          `Outer extraction exit ${child.status}; complete payload length and inner MIX validation determine recoverability`,
        );
    }
    result.bytes = bytes.length;
    result.sha256 = hash(bytes);
    if (bytes.length !== source.expected_bytes)
      throw new Error(`Payload truncated: expected ${source.expected_bytes}, got ${bytes.length}`);
    if (
      source.expected_crc &&
      crc32(bytes).toString(16).padStart(8, '0').toUpperCase() !== source.expected_crc.toUpperCase()
    ) {
      throw new Error(`Package payload CRC mismatch for ${source.member}`);
    }
    scan(bytes, source.member ? `${source.path}!${source.member}` : source.path, 0, result, new Set());
    result.state = result.errors.length ? 'parsed with outer/named errors' : 'parsed';
  } catch (error) {
    result.state = 'failed';
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  results.push(result);
  const summary = save();
  console.log(
    JSON.stringify({
      source: basename(source.path),
      member: source.member,
      state: result.state,
      nodes: result.nodes.length,
      ...summary,
    }),
  );
}
console.log(JSON.stringify(save()));
