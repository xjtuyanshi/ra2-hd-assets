#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { open, readdir, stat, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const KNOWN_HASHES = Object.freeze(
  [
    {
      filename: 'gamemd.exe',
      sha256: '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6',
      label: 'RA2 VM pinned YR 1.001',
    },
    {
      filename: 'gamemd.exe',
      sha256: '1cdd1180e49024fbda8ad568caac2e86e856063ff67ab38f62b7d2c7bb84298c',
      label: 'vera20k reference YR 1.001',
    },
    {
      filename: 'game.exe',
      sha256: '06f994965ebde56116d5d53b2e8ffb0c999124166ad99032566cc33d7f83ccdb',
      label: 'RA2 VM pinned RA2',
    },
  ].map(Object.freeze),
);
const INVENTORY = {
  executables: ['gamemd.exe', 'game.exe', 'ra2.exe', 'ra2md.exe', 'yuri.exe'],
  requiredYR: ['ra2md.mix', 'langmd.mix', 'binkw32.dll', 'blowfish.dll'],
  requiredRA2: ['ra2.mix', 'language.mix'],
  optional: [
    'expandmd01.mix',
    'multimd.mix',
    'mapsmd03.mix',
    'movmd03.mix',
    'thememd.mix',
    'theme.mix',
    'maps01.mix',
    'maps02.mix',
    'movies01.mix',
    'movies02.mix',
    'multi.mix',
    'game.fnt',
    'subtitlemd.txt',
  ],
};

export function matchKnownHash(filename, sha256, table = KNOWN_HASHES) {
  return (
    table.find(
      (row) =>
        row.filename.toLowerCase() === path.basename(filename).toLowerCase() &&
        row.sha256.toLowerCase() === sha256.toLowerCase(),
    )?.label ?? null
  );
}

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

// Random-access reads keep memory bounded even for very large executable files.
async function reader(source) {
  const buffer = Buffer.isBuffer(source) ? source : null;
  const handle = buffer ? null : await open(source, 'r');
  const size = buffer ? buffer.length : (await handle.stat()).size;
  return {
    size,
    close: async () => {
      await handle?.close();
    },
    async read(offset, length) {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset + length > size
      )
        throw new Error('PE read outside file');
      if (buffer) return buffer.subarray(offset, offset + length);
      const result = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(result, done, length - done, offset + done);
        if (!bytesRead) throw new Error('Truncated PE file');
        done += bytesRead;
      }
      return result;
    },
  };
}

async function entropy(input, offset, length) {
  const counts = new Float64Array(256);
  for (let done = 0; done < length; done += 65536) {
    const chunk = await input.read(offset + done, Math.min(65536, length - done));
    for (const byte of chunk) counts[byte]++;
  }
  let value = 0;
  for (const count of counts)
    if (count) {
      const p = count / length;
      value -= p * Math.log2(p);
    }
  return value;
}

function versionStrings(blob) {
  const align = (n) => Math.ceil(n / 4) * 4;
  const versions = { FileVersion: null, ProductVersion: null };
  let blocks = 0;
  function visit(start, limit, depth) {
    if (++blocks > 1024 || depth > 8 || start + 6 > limit) throw new Error('Invalid version block');
    const end = start + blob.readUInt16LE(start);
    const valueLength = blob.readUInt16LE(start + 2),
      type = blob.readUInt16LE(start + 4);
    if (end <= start + 6 || end > limit) throw new Error('Invalid version length');
    let pos = start + 6;
    while (pos + 2 <= end && blob.readUInt16LE(pos) !== 0) pos += 2;
    if (pos + 2 > end) throw new Error('Unterminated version key');
    const key = blob.toString('utf16le', start + 6, pos);
    if (depth === 0 && key !== 'VS_VERSION_INFO') throw new Error('Invalid version root');
    const valueStart = align(pos + 2),
      valueEnd = valueStart + valueLength * (type === 1 ? 2 : 1);
    if (valueLength && valueEnd > end) throw new Error('Invalid version value');
    if (Object.hasOwn(versions, key) && type === 1 && valueLength) {
      versions[key] = blob.toString('utf16le', valueStart, valueEnd).replace(/\0+$/, '');
    }
    for (pos = align(valueEnd); pos + 6 <= end;) pos = align(visit(pos, end, depth + 1));
    return end;
  }
  visit(0, blob.length, 0);
  return versions;
}

async function readVersion(readRVA, directory) {
  if (!directory.rva || directory.size < 16) return null;
  try {
    const visited = new Set();
    async function readRelative(offset, length) {
      if (offset + length > directory.size) throw new Error('Resource outside directory');
      return readRVA(directory.rva + offset, length);
    }
    async function walk(offset, depth) {
      if (depth > 4 || visited.size >= 256 || visited.has(offset)) throw new Error('Invalid resource tree');
      visited.add(offset);
      const header = await readRelative(offset, 16);
      const count = header.readUInt16LE(12) + header.readUInt16LE(14);
      if (count > 4096) throw new Error('Excessive resource entries');
      const entries = await readRelative(offset + 16, count * 8);
      for (let i = 0; i < count; i++) {
        const id = entries.readUInt32LE(i * 8),
          target = entries.readUInt32LE(i * 8 + 4);
        if (depth === 0 && id !== 16) continue; // RT_VERSION
        if (target & 0x80000000) {
          const found = await walk(target & 0x7fffffff, depth + 1);
          if (found) return found;
        } else {
          const entry = await readRelative(target, 16);
          const size = entry.readUInt32LE(4);
          if (size < 6 || size > 1024 * 1024) throw new Error('Invalid version resource size');
          return versionStrings(await readRVA(entry.readUInt32LE(0), size));
        }
      }
      return null;
    }
    return await walk(0, 0);
  } catch {
    return null;
  }
}

function protectionFlags(pe) {
  const flags = [];
  const add = (code, reason) => flags.push({ code, reason });
  const markers = new Map([
    ['.bind', 'Steam SteamStub'],
    ['.ooa', 'EA/Origin OAC'],
    ['.securom', 'SecuROM'],
    ['.dsstext', 'SecuROM'],
    ['stxt774', 'SafeDisc'],
    ['stxt371', 'SafeDisc'],
    ['upx0', 'UPX'],
    ['upx1', 'UPX'],
    ['.vmp0', 'VMProtect'],
    ['.vmp1', 'VMProtect'],
    ['.themida', 'Themida'],
    ['.winlice', 'Themida'],
    ['.enigma1', 'Enigma'],
  ]);
  for (const section of pe.sections) {
    const marker = markers.get(section.name.toLowerCase());
    if (marker) add('section_marker', `${section.name} section suggests ${marker}`);
    if (section.characteristics & 0x20000000 && section.entropy > 7.2) {
      add('high_entropy', `Executable section ${section.name} has entropy ${section.entropy.toFixed(3)} > 7.2`);
    }
  }
  for (const dll of pe.imports) {
    if (/^(steam_api|steam_api64)\.dll$/i.test(dll))
      add('steam_import', `${dll} import suggests Steam integration/protection`);
    if (/drmdll/i.test(dll)) add('drm_import', `${dll} import suggests DRM`);
    if (/secdrv/i.test(dll)) add('secdrv_import', `${dll} import suggests SafeDisc/secdrv`);
  }
  const executable = pe.sections.find((s) => s.characteristics & 0x20000000);
  const entry = pe.sections.find(
    (s) =>
      pe.entryPointRVA >= s.virtualAddress &&
      pe.entryPointRVA < s.virtualAddress + Math.max(s.virtualSize, s.sizeOfRawData),
  );
  if (!entry || entry !== executable)
    add('entry_not_first_executable', 'Entry point is not in the first executable section');
  if (!entry || entry.name.toLowerCase() !== '.text') add('entry_not_text', 'Entry point is not in .text');
  return flags;
}

export async function analyzePE(source) {
  const pe = {
    validDOS: false,
    validPE: false,
    machine: null,
    machineName: null,
    timeDateStamp: null,
    imageBase: null,
    entryPointRVA: null,
    entrySection: null,
    sections: [],
    imports: [],
    overlaySize: null,
    versionInfo: null,
    flags: [],
    verdict: 'not_pe',
  };
  let input;
  try {
    input = await reader(source);
    const dos = await input.read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error('Missing DOS MZ signature');
    pe.validDOS = true;
    const peOffset = dos.readUInt32LE(60);
    if (peOffset < 64) throw new Error('Invalid PE header offset');
    const header = await input.read(peOffset, 24);
    if (header.readUInt32LE(0) !== 0x4550) throw new Error('Missing PE signature');
    const sectionCount = header.readUInt16LE(6),
      optionalSize = header.readUInt16LE(20);
    if (!sectionCount || sectionCount > 1024 || optionalSize > 4096) throw new Error('Invalid PE header sizes');
    const optional = await input.read(peOffset + 24, optionalSize);
    const magic = optional.readUInt16LE(0),
      plus = magic === 0x20b;
    const directoryOffset = plus ? 112 : 96;
    if ((magic !== 0x10b && !plus) || optionalSize < directoryOffset) throw new Error('Invalid PE optional header');
    const headersSize = optional.readUInt32LE(60);
    const sectionOffset = peOffset + 24 + optionalSize;
    if (headersSize < sectionOffset + sectionCount * 40 || headersSize > input.size)
      throw new Error('Invalid SizeOfHeaders');
    pe.machine = header.readUInt16LE(4);
    pe.machineName = { 332: 'I386', 34404: 'AMD64', 43620: 'ARM64' }[pe.machine] ?? 'unknown';
    pe.timeDateStamp = new Date(header.readUInt32LE(8) * 1000).toISOString();
    pe.imageBase = `0x${(plus ? optional.readBigUInt64LE(24) : optional.readUInt32LE(28)).toString(16)}`;
    pe.entryPointRVA = optional.readUInt32LE(16);
    const table = await input.read(sectionOffset, sectionCount * 40);
    let lastEnd = headersSize;
    for (let i = 0; i < sectionCount; i++) {
      const offset = i * 40;
      const section = {
        name: table.toString('latin1', offset, offset + 8).replace(/\0.*$/, ''),
        virtualSize: table.readUInt32LE(offset + 8),
        virtualAddress: table.readUInt32LE(offset + 12),
        sizeOfRawData: table.readUInt32LE(offset + 16),
        pointerToRawData: table.readUInt32LE(offset + 20),
        characteristics: table.readUInt32LE(offset + 36),
        entropy: 0,
      };
      if (section.sizeOfRawData) {
        if (section.pointerToRawData < headersSize || section.pointerToRawData + section.sizeOfRawData > input.size) {
          throw new Error(`Invalid raw data range for ${section.name}`);
        }
        section.entropy = await entropy(input, section.pointerToRawData, section.sizeOfRawData);
        lastEnd = Math.max(lastEnd, section.pointerToRawData + section.sizeOfRawData);
      }
      pe.sections.push(section);
    }
    pe.validPE = true;
    pe.overlaySize = input.size - lastEnd;
    pe.entrySection =
      pe.sections.find(
        (s) =>
          pe.entryPointRVA >= s.virtualAddress &&
          pe.entryPointRVA < s.virtualAddress + Math.max(s.virtualSize, s.sizeOfRawData),
      )?.name ?? null;
    const rvaRange = (rva) => {
      if (rva < headersSize) return { offset: rva, available: headersSize - rva };
      const s = pe.sections.find((s) => rva >= s.virtualAddress && rva < s.virtualAddress + s.sizeOfRawData);
      if (!s) throw new Error('Unmapped RVA');
      return {
        offset: s.pointerToRawData + rva - s.virtualAddress,
        available: s.sizeOfRawData - (rva - s.virtualAddress),
      };
    };
    const readRVA = async (rva, length) => {
      const range = rvaRange(rva);
      if (length > range.available) throw new Error('RVA crosses raw data boundary');
      return input.read(range.offset, length);
    };
    const directoryCount = optional.readUInt32LE(directoryOffset - 4);
    const directory = (index) =>
      index < directoryCount && directoryOffset + index * 8 + 8 <= optionalSize
        ? {
            rva: optional.readUInt32LE(directoryOffset + index * 8),
            size: optional.readUInt32LE(directoryOffset + index * 8 + 4),
          }
        : { rva: 0, size: 0 };
    try {
      const imports = directory(1);
      for (let i = 0; imports.rva && (i + 1) * 20 <= imports.size && i < 4096; i++) {
        const descriptor = await readRVA(imports.rva + i * 20, 20);
        if (descriptor.every((byte) => byte === 0)) break;
        const nameRVA = descriptor.readUInt32LE(12),
          range = rvaRange(nameRVA);
        const name = await readRVA(nameRVA, Math.min(range.available, 4096));
        const end = name.indexOf(0);
        if (end < 0) throw new Error('Unterminated import name');
        const dll = name.toString('latin1', 0, end);
        if (dll && !pe.imports.includes(dll)) pe.imports.push(dll);
      }
    } catch {
      pe.imports = [];
    }
    pe.versionInfo = await readVersion(readRVA, directory(2));
    pe.flags = protectionFlags(pe);
    pe.verdict = pe.flags.length ? 'protection_suspected' : 'likely_clean';
  } catch (error) {
    pe.error = error.message;
  } finally {
    await input?.close();
  }
  return pe;
}

export async function scanGameDir(gameDir, knownHashes = KNOWN_HASHES) {
  const root = await realpath(gameDir);
  if (!(await stat(root)).isDirectory()) throw new Error('gameDir must be a directory');
  const report = { gameDir: root, inventory: [], binaries: [], errors: [], skipped: [] };
  const wanted = new Map();
  for (const [category, names] of Object.entries(INVENTORY))
    for (const name of names) {
      const item = { name, category, present: false, matches: [] };
      wanted.set(name, item);
      report.inventory.push(item);
    }
  async function visit(directory, depth) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      report.errors.push(`${path.relative(root, directory) || '.'}: ${error.message}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory() && depth === 0) {
        await visit(filename, 1);
        continue;
      }
      let regular = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          regular = (await stat(filename)).isFile();
        } catch (error) {
          report.errors.push(`${path.relative(root, filename)}: ${error.message}`);
          continue;
        }
        if (!regular)
          report.skipped.push(`${path.relative(root, filename)}: directory/non-file symbolic link not traversed`);
      }
      if (!regular) continue;
      const name = entry.name.toLowerCase(),
        item = wanted.get(name),
        binary = /\.(exe|dll)$/i.test(name);
      if (!item && !binary) continue;
      const file = { path: path.relative(root, filename), size: null, sha256: null, knownHash: null };
      try {
        file.size = (await stat(filename)).size;
        file.sha256 = await hashFile(filename);
        if (name.endsWith('.exe')) file.knownHash = matchKnownHash(name, file.sha256, knownHashes);
      } catch (error) {
        file.error = error.message;
        report.errors.push(`${file.path}: ${error.message}`);
      }
      if (binary) {
        file.pe = await analyzePE(filename);
        report.binaries.push(file);
      }
      if (item) {
        item.present = true;
        item.matches.push(file);
      }
    }
  }
  await visit(root, 0);
  return report;
}

const hex = (value) => (value === null ? '-' : `0x${value.toString(16)}`);
const safe = (value) =>
  String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
export function formatReport(report) {
  const lines = [
    `Directory: ${safe(report.gameDir)}`,
    'Inventory (top level + one subfolder level):',
    'FILE | PRESENT | PATH | BYTES | SHA256',
  ];
  for (const item of report.inventory) {
    if (!item.present) lines.push(`${item.name} | NO | - | - | -`);
    for (const file of item.matches)
      lines.push(`${item.name} | YES | ${safe(file.path)} | ${file.size ?? '-'} | ${file.sha256 ?? 'unreadable'}`);
  }
  for (const file of report.binaries) {
    const pe = file.pe;
    lines.push(
      `\nPE ${safe(file.path)}: ${pe.verdict}; DOS=${pe.validDOS}; PE=${pe.validPE}`,
      `  SHA256=${file.sha256 ?? 'unreadable'}; known hash=${file.knownHash ?? 'no match'}`,
    );
    if (pe.error) lines.push(`  Error: ${safe(pe.error)}`);
    if (!pe.validPE) continue;
    lines.push(
      `  Machine=${hex(pe.machine)} (${pe.machineName}); TimeDateStamp=${pe.timeDateStamp}; ImageBase=${pe.imageBase}`,
      `  Entry RVA=${hex(pe.entryPointRVA)}; section=${safe(pe.entrySection ?? '(none)')}; overlay=${pe.overlaySize} bytes`,
      '  SECTION | VirtualSize | SizeOfRawData | Characteristics | Entropy',
    );
    for (const s of pe.sections)
      lines.push(
        `  ${safe(s.name)} | ${s.virtualSize} | ${s.sizeOfRawData} | ${hex(s.characteristics)} | ${s.entropy.toFixed(4)}`,
      );
    lines.push(
      `  Imports: ${pe.imports.map(safe).join(', ') || '(none)'}`,
      `  Version strings: ${JSON.stringify(pe.versionInfo)}`,
    );
    for (const flag of pe.flags) lines.push(`  Flag: ${safe(flag.reason)}`);
  }
  const yr = report.inventory.find((item) => item.name === 'gamemd.exe').matches;
  for (const file of yr)
    lines.push(
      `\nYR exe: ${safe(file.path)} sha256=${file.sha256 ?? 'unreadable'} matches "RA2 VM pinned YR 1.001": ${file.sha256 === KNOWN_HASHES[0].sha256 ? 'YES' : 'NO'}; protection: ${file.pe.verdict === 'likely_clean' ? 'none detected' : file.pe.verdict}`,
    );
  if (!yr.length) lines.push('\nYR exe: gamemd.exe missing');
  const missing = (category) =>
    report.inventory
      .filter((i) => i.category === category && !i.present)
      .map((i) => i.name)
      .join(', ') || 'none';
  const suspected = report.binaries.filter((f) => f.pe.verdict === 'protection_suspected').length;
  const invalid = report.binaries.filter((f) => f.pe.verdict === 'not_pe').length;
  lines.push(
    `Overall: ${report.binaries.length} binaries; ${suspected} protection suspected; ${invalid} not PE; ${report.errors.length} read errors.`,
    `Missing required YR: ${missing('requiredYR')}; missing required RA2: ${missing('requiredRA2')}.`,
    'Heuristics are indicators; likely_clean does not prove absence of protection.',
  );
  for (const error of report.errors) lines.push(`Read error: ${safe(error)}`);
  for (const skipped of report.skipped) lines.push(`Skipped: ${safe(skipped)}`);
  return lines.join('\n');
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Reject in-tree outputs, symlink aliases, and existing hard links before opening for writing.
async function outputPath(gameDir, output) {
  const root = await realpath(gameDir),
    absolute = path.resolve(output);
  const parent = await realpath(path.dirname(absolute));
  const canonical = path.join(parent, path.basename(absolute));
  if (inside(path.resolve(gameDir), absolute) || inside(root, canonical))
    throw new Error('--json output must be outside gameDir');
  try {
    const info = await lstat(canonical);
    if (info.isSymbolicLink() || info.nlink > 1)
      throw new Error('--json output must not be a symbolic link or hard link');
    if (inside(root, await realpath(canonical))) throw new Error('--json output must be outside gameDir');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return canonical;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node g1-probe.mjs <gameDir> [--json out.json]');
    return;
  }
  if (!(args.length === 1 || (args.length === 3 && args[1] === '--json')) || args[0].startsWith('--')) {
    throw new Error('Usage: node g1-probe.mjs <gameDir> [--json out.json]');
  }
  const output = args.length === 3 ? await outputPath(args[0], args[2]) : null;
  const report = await scanGameDir(args[0]);
  if (output) {
    // Recheck after scanning; exclusive create prevents replacement through a new symlink.
    await outputPath(args[0], output);
    const handle = await open(output, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
      await handle.close();
    }
  }
  console.log(formatReport(report));
  if (report.errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`g1-probe: ${error.message}`);
    process.exitCode = 1;
  });
}
