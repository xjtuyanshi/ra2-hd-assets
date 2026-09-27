import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { KNOWN_HASHES, matchKnownHash, hashFile, analyzePE, scanGameDir } from './g1-probe.mjs';

const align = (number, boundary = 4) => Math.ceil(number / boundary) * boundary;
const executable = 0x60000020;
const cli = fileURLToPath(new URL('./g1-probe.mjs', import.meta.url));

// Minimal PE assembler: separate virtual/raw locations catch RVA/file-offset confusion.
function makePE({
  sections = [{ name: '.text' }],
  entry = 0x1000,
  pe64 = false,
  directories = {},
  overlay = Buffer.alloc(0),
} = {}) {
  const peOffset = 0x80;
  const optionalSize = pe64 ? 240 : 224;
  const optional = peOffset + 24;
  const sectionTable = optional + optionalSize;
  const headerSize = align(sectionTable + sections.length * 40, 0x200);
  let rawOffset = headerSize;
  const assembled = sections.map((section, i) => {
    const data = section.data ?? Buffer.from([0x90, 0x90, 0xc3]);
    const result = {
      name: section.name,
      data,
      virtualAddress: section.virtualAddress ?? (i + 1) * 0x1000,
      virtualSize: section.virtualSize ?? data.length,
      rawSize: align(data.length, 0x200),
      characteristics: section.characteristics ?? executable,
      rawOffset,
    };
    rawOffset += result.rawSize;
    return result;
  });
  const buffer = Buffer.alloc(rawOffset + overlay.length);
  buffer.write('MZ');
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write('PE\0\0', peOffset);
  buffer.writeUInt16LE(pe64 ? 0x8664 : 0x14c, peOffset + 4);
  buffer.writeUInt16LE(sections.length, peOffset + 6);
  buffer.writeUInt32LE(1577836800, peOffset + 8);
  buffer.writeUInt16LE(optionalSize, peOffset + 20);
  buffer.writeUInt16LE(0x102, peOffset + 22);
  buffer.writeUInt16LE(pe64 ? 0x20b : 0x10b, optional);
  buffer.writeUInt32LE(entry, optional + 16);
  buffer.writeUInt32LE(0x1000, optional + 20);
  if (pe64) buffer.writeBigUInt64LE(0x140000000n, optional + 24);
  else buffer.writeUInt32LE(0x400000, optional + 28);
  buffer.writeUInt32LE(0x1000, optional + 32);
  buffer.writeUInt32LE(0x200, optional + 36);
  buffer.writeUInt32LE((sections.length + 1) * 0x1000, optional + 56);
  buffer.writeUInt32LE(headerSize, optional + 60);
  buffer.writeUInt16LE(3, optional + 68);
  buffer.writeUInt32LE(16, optional + (pe64 ? 108 : 92));
  for (const [index, [rva, size]] of Object.entries(directories)) {
    const position = optional + (pe64 ? 112 : 96) + Number(index) * 8;
    buffer.writeUInt32LE(rva, position);
    buffer.writeUInt32LE(size, position + 4);
  }
  assembled.forEach((section, i) => {
    const position = sectionTable + i * 40;
    buffer.write(section.name, position, 8, 'ascii');
    buffer.writeUInt32LE(section.virtualSize, position + 8);
    buffer.writeUInt32LE(section.virtualAddress, position + 12);
    buffer.writeUInt32LE(section.rawSize, position + 16);
    buffer.writeUInt32LE(section.rawOffset, position + 20);
    buffer.writeUInt32LE(section.characteristics, position + 36);
    section.data.copy(buffer, section.rawOffset);
  });
  overlay.copy(buffer, rawOffset);
  return buffer;
}

function importData(names) {
  const data = Buffer.alloc(0x200);
  let position = (names.length + 1) * 20;
  names.forEach((name, i) => {
    data.writeUInt32LE(0x2000 + position, i * 20 + 12);
    data.write(name + '\0', position, 'ascii');
    position += name.length + 1;
  });
  return data;
}

function versionBlock(key, value = Buffer.alloc(0), children = [], text = false) {
  const keyBytes = Buffer.from(key + '\0', 'utf16le');
  const valueOffset = align(6 + keyBytes.length);
  let length = align(valueOffset + value.length);
  const childOffsets = children.map((child) => {
    const offset = length;
    length = align(length + child.length);
    return offset;
  });
  const block = Buffer.alloc(length);
  block.writeUInt16LE(length, 0);
  block.writeUInt16LE(text ? value.length / 2 : value.length, 2);
  block.writeUInt16LE(text ? 1 : 0, 4);
  keyBytes.copy(block, 6);
  value.copy(block, valueOffset);
  children.forEach((child, i) => child.copy(block, childOffsets[i]));
  return block;
}

function versionResource() {
  const string = (key, value) => versionBlock(key, Buffer.from(value + '\0', 'utf16le'), [], true);
  const table = versionBlock(
    '040904B0',
    undefined,
    [string('FileVersion', '1.001'), string('ProductVersion', "Yuri's Revenge 1.001")],
    true,
  );
  const strings = versionBlock('StringFileInfo', undefined, [table], true);
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd);
  const root = versionBlock('VS_VERSION_INFO', fixed, [strings]);
  const resource = Buffer.alloc(align(128 + root.length, 0x200));
  for (const [offset, id, target] of [
    [0, 16, 0x80000020],
    [32, 1, 0x80000040],
    [64, 1033, 96],
  ]) {
    resource.writeUInt16LE(1, offset + 14);
    resource.writeUInt32LE(id, offset + 16);
    resource.writeUInt32LE(target, offset + 20);
  }
  resource.writeUInt32LE(0x2000 + 128, 96);
  resource.writeUInt32LE(root.length, 100);
  root.copy(resource, 128);
  return resource;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'g1-probe-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function snapshot(directory, prefix = '') {
  const output = [];
  if (!prefix) {
    const rootInfo = await stat(directory, { bigint: true });
    output.push({ path: '.', mtime: String(rootInfo.mtimeNs) });
  }
  for (const name of (await readdir(directory)).sort()) {
    const relative = path.join(prefix, name);
    const filename = path.join(directory, name);
    const info = await stat(filename, { bigint: true });
    output.push({
      path: relative,
      size: String(info.size),
      mtime: String(info.mtimeNs),
      sha256: info.isFile() ? await hashFile(filename) : null,
    });
    if (info.isDirectory()) output.push(...(await snapshot(filename, relative)));
  }
  return output;
}

test('clean PE32 reports headers, section details, entry point and no protection', async () => {
  const result = await analyzePE(makePE());
  assert.equal(result.validDOS, true);
  assert.equal(result.validPE, true);
  assert.equal(result.verdict, 'likely_clean');
  assert.equal(result.machine, 0x14c);
  assert.ok(result.machineName);
  assert.equal(result.timeDateStamp, '2020-01-01T00:00:00.000Z');
  assert.equal(result.imageBase.toLowerCase(), '0x400000');
  assert.equal(result.entryPointRVA, 0x1000);
  assert.equal(result.entrySection, '.text');
  assert.deepEqual(
    result.sections.map((section) => section.name),
    ['.text'],
  );
  assert.equal(result.sections[0].virtualSize, 3);
  assert.equal(result.sections[0].sizeOfRawData, 0x200);
  assert.equal(result.sections[0].characteristics, executable);
  assert.equal(result.sections[0].virtualAddress, 0x1000);
  assert.equal(result.sections[0].pointerToRawData, 0x200);
  assert.ok(result.sections[0].entropy < 1);
  assert.deepEqual(result.imports, []);
  assert.deepEqual(result.flags, []);
  assert.equal(result.overlaySize, 0);
});

for (const [name, reason] of [
  ['.bind', /SteamStub/i],
  ['.ooa', /Origin|OAC/i],
  ['.securom', /SecuROM/i],
  ['.dsstext', /SecuROM/i],
  ['stxt774', /SafeDisc/i],
  ['stxt371', /SafeDisc/i],
  ['UPX0', /UPX/i],
  ['UPX1', /UPX/i],
  ['.vmp0', /VMProtect/i],
  ['.vmp1', /VMProtect/i],
  ['.themida', /Themida/i],
  ['.winlice', /Themida|WinLicense/i],
  ['.enigma1', /Enigma/i],
]) {
  test(`protection section ${name} is identified`, async () => {
    const result = await analyzePE(makePE({ sections: [{ name: '.text' }, { name }] }));
    assert.equal(result.verdict, 'protection_suspected');
    assert.ok(
      result.flags.some((flag) => reason.test(flag.reason)),
      JSON.stringify(result.flags),
    );
  });
}

test('entry in a later executable section or outside .text is flagged', async () => {
  for (const fixture of [
    makePE({ sections: [{ name: '.text' }, { name: '.extra' }], entry: 0x2000 }),
    makePE({ sections: [{ name: '.code' }] }),
    makePE({ entry: 0x9000 }),
  ]) {
    const result = await analyzePE(fixture);
    assert.equal(result.verdict, 'protection_suspected');
    assert.ok(result.flags.some((flag) => /entry|entry.point/i.test(flag.reason)));
  }
  const firstExecutable = await analyzePE(
    makePE({ sections: [{ name: '.rdata', characteristics: 0x40000040 }, { name: '.text' }], entry: 0x2000 }),
  );
  assert.equal(firstExecutable.verdict, 'likely_clean');
});

test('deterministic random executable bytes have high entropy and are flagged', async () => {
  const data = Buffer.alloc(8192);
  let state = 0x12345678;
  for (let i = 0; i < data.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 255;
  }
  const result = await analyzePE(makePE({ sections: [{ name: '.text', data }] }));
  assert.ok(result.sections[0].entropy > 7.2);
  assert.equal(result.verdict, 'protection_suspected');
  assert.ok(result.flags.some((flag) => /entropy/i.test(flag.reason)));
  const plainData = await analyzePE(
    makePE({ sections: [{ name: '.text' }, { name: '.data', data, characteristics: 0x40000040 }] }),
  );
  assert.equal(plainData.verdict, 'likely_clean');
});

test('non-PE and malformed or truncated PE headers fail safely', async () => {
  const badOffset = makePE();
  badOffset.writeUInt32LE(0xfffffff0, 0x3c);
  const badMagic = makePE();
  badMagic.writeUInt16LE(0x999, 0x98);
  for (const source of [
    Buffer.alloc(0),
    Buffer.from('plain text'),
    Buffer.from('MZ'),
    badOffset,
    badMagic,
    makePE().subarray(0, 0x90),
    makePE().subarray(0, 0x190),
  ]) {
    const result = await analyzePE(source);
    assert.equal(result.verdict, 'not_pe');
    assert.equal(result.validPE, false);
  }
});

test('high-bit bytes cannot impersonate an exact DOS MZ signature', async () => {
  const source = makePE();
  source[0] = 0xcd;
  source[1] = 0xda;
  const result = await analyzePE(source);
  assert.equal(result.validDOS, false);
  assert.equal(result.validPE, false);
  assert.equal(result.verdict, 'not_pe');
});

test('PE32+ uses the 64-bit image base and counts only the trailing overlay', async () => {
  const result = await analyzePE(makePE({ pe64: true, overlay: Buffer.from('overlay!') }));
  assert.equal(result.verdict, 'likely_clean');
  assert.equal(result.machine, 0x8664);
  assert.equal(result.imageBase.toLowerCase(), '0x140000000');
  assert.equal(result.overlaySize, 8);
});

test('import directory resolves RVAs and identifies DRM DLLs in PE32 and PE32+', async () => {
  for (const pe64 of [false, true]) {
    const names = ['KERNEL32.dll', 'steam_api64.dll', 'drmdll.dll', 'secdrv.sys'];
    const result = await analyzePE(
      makePE({
        pe64,
        sections: [{ name: '.text' }, { name: '.idata', data: importData(names), characteristics: 0x40000040 }],
        directories: { 1: [0x2000, (names.length + 1) * 20] },
      }),
    );
    assert.deepEqual(
      result.imports.map((name) => name.toLowerCase()).sort(),
      names.map((name) => name.toLowerCase()).sort(),
    );
    assert.equal(result.verdict, 'protection_suspected');
    for (const name of ['steam', 'drmdll', 'secdrv']) {
      assert.ok(
        result.flags.some((flag) => flag.reason.toLowerCase().includes(name)),
        JSON.stringify(result.flags),
      );
    }
  }
});

test('version resource directory yields FileVersion and ProductVersion strings', async () => {
  const data = versionResource();
  const result = await analyzePE(
    makePE({
      sections: [{ name: '.text' }, { name: '.rsrc', data, characteristics: 0x40000040 }],
      directories: { 2: [0x2000, data.length] },
    }),
  );
  assert.deepEqual(result.versionInfo, { FileVersion: '1.001', ProductVersion: "Yuri's Revenge 1.001" });
});

test('malformed import and section data offsets do not crash analysis', async () => {
  const badImport = makePE({ directories: { 1: [0xfffffff0, 0xffffffff] } });
  const badSection = makePE();
  badSection.writeUInt32LE(0xffffffff, 0x178 + 20);
  for (const [source, validPE, verdict] of [
    [badImport, true, 'likely_clean'],
    [badSection, false, 'not_pe'],
  ]) {
    const result = await analyzePE(source);
    assert.equal(result.validDOS, true);
    assert.equal(result.validPE, validPE);
    assert.equal(result.verdict, verdict);
    assert.deepEqual(result.imports, []);
    assert.deepEqual(result.flags, []);
  }
});

test('malformed resource directory is bounded and reports null', async () => {
  for (const target of [0x80000000, 0x7ffffff0]) {
    const data = versionResource();
    data.writeUInt32LE(target, 20);
    const result = await analyzePE(
      makePE({
        sections: [{ name: '.text' }, { name: '.rsrc', data, characteristics: 0x40000040 }],
        directories: { 2: [0x2000, data.length] },
      }),
    );
    assert.equal(result.versionInfo, null);
    assert.equal(result.validPE, true);
  }
});

test('malformed version payloads yield null without invalidating the PE headers', async () => {
  for (const [offset, value] of [
    [128, 0],
    [130, 0xffff],
    [134, 0x58],
  ]) {
    const data = versionResource();
    data.writeUInt16LE(value, offset);
    const result = await analyzePE(
      makePE({
        sections: [{ name: '.text' }, { name: '.rsrc', data, characteristics: 0x40000040 }],
        directories: { 2: [0x2000, data.length] },
      }),
    );
    assert.equal(result.versionInfo, null);
    assert.equal(result.validPE, true);
    assert.equal(result.verdict, 'likely_clean');
  }
});

test('known hashes are exported, case-insensitive, filename-specific and injectable', async (t) => {
  assert.equal(KNOWN_HASHES.length, 3);
  for (const known of KNOWN_HASHES) {
    assert.equal(matchKnownHash(known.filename.toUpperCase(), known.sha256.toUpperCase()), known.label);
  }
  const directory = await temporaryDirectory(t);
  const filename = path.join(directory, 'GaMeMd.ExE');
  const bytes = Buffer.from('a controlled fixture, not a production executable');
  await writeFile(filename, bytes);
  const sha256 = await hashFile(filename);
  assert.equal(sha256, createHash('sha256').update(bytes).digest('hex'));
  const table = [{ filename: 'gamemd.exe', sha256, label: 'synthetic known executable' }];
  assert.equal(matchKnownHash('GAMEMD.EXE', sha256, table), table[0].label);
  assert.equal(matchKnownHash('game.exe', sha256, table), null);
  assert.equal(matchKnownHash('gamemd.exe', '0'.repeat(64), table), null);
  const result = await scanGameDir(directory, table);
  assert.equal(result.binaries[0].knownHash, table[0].label);
});

test('inventory finds case-insensitive names one level down and leaves every file unchanged', async (t) => {
  const directory = await temporaryDirectory(t);
  await mkdir(path.join(directory, 'Sub', 'Deep'), { recursive: true });
  await writeFile(path.join(directory, 'GaMeMd.ExE'), makePE());
  await writeFile(path.join(directory, 'RA2MD.MIX'), 'archive');
  await writeFile(path.join(directory, 'Sub', 'GaMe.ExE'), makePE());
  await writeFile(path.join(directory, 'Sub', 'GAMEMD.EXE'), makePE());
  await writeFile(path.join(directory, 'Sub', 'BINKW32.DLL'), makePE());
  await writeFile(path.join(directory, 'Sub', 'other.DlL'), makePE());
  await writeFile(path.join(directory, 'Sub', 'Deep', 'ra2.mix'), 'too deep');
  const before = await snapshot(directory);
  const result = await scanGameDir(directory);
  assert.deepEqual(await snapshot(directory), before);
  assert.equal(result.inventory.length, 24);
  assert.equal(result.inventory.find((item) => item.name === 'gamemd.exe').category, 'executables');
  assert.equal(result.inventory.find((item) => item.name === 'ra2md.mix').category, 'requiredYR');
  assert.equal(result.inventory.find((item) => item.name === 'ra2.mix').present, false);
  assert.equal(result.inventory.find((item) => item.name === 'theme.mix').present, false);
  for (const [name, relative] of [
    ['gamemd.exe', 'GaMeMd.ExE'],
    ['game.exe', 'Sub/GaMe.ExE'],
    ['binkw32.dll', 'Sub/BINKW32.DLL'],
  ]) {
    const item = result.inventory.find((item) => item.name === name);
    assert.equal(item.present, true);
    assert.equal(item.matches[0].path.replaceAll(path.sep, '/'), relative);
    assert.match(item.matches[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(item.matches[0].size > 0);
  }
  const duplicates = result.inventory.find((item) => item.name === 'gamemd.exe').matches;
  assert.deepEqual(duplicates.map((item) => item.path.replaceAll(path.sep, '/')).sort(), [
    'GaMeMd.ExE',
    'Sub/GAMEMD.EXE',
  ]);
  assert.equal(result.binaries.length, 5);
  assert.ok(result.binaries.every((binary) => binary.pe.verdict === 'likely_clean'));
  assert.deepEqual(result.errors, []);
});

test('file symlinks retain encountered paths while directory links and cycles are skipped', async (t) => {
  const directory = await temporaryDirectory(t);
  const gameDir = path.join(directory, 'game');
  const storage = path.join(directory, 'storage');
  await mkdir(path.join(gameDir, 'Sub'), { recursive: true });
  await mkdir(storage);
  const target = path.join(storage, 'payload.bin');
  const bytes = makePE();
  await writeFile(target, bytes);
  await writeFile(path.join(storage, 'yuri.exe'), bytes);
  await symlink(target, path.join(gameDir, 'GAMEMD.EXE'));
  await symlink(target, path.join(gameDir, 'Sub', 'BINKW32.DLL'));
  await symlink(storage, path.join(gameDir, 'linked-content'));
  await symlink(gameDir, path.join(gameDir, 'cycle'));
  const before = await stat(target, { bigint: true });
  const result = await scanGameDir(gameDir);
  assert.deepEqual(result.binaries.map((file) => file.path.replaceAll(path.sep, '/')).sort(), [
    'GAMEMD.EXE',
    'Sub/BINKW32.DLL',
  ]);
  assert.ok(result.binaries.every((file) => file.pe.verdict === 'likely_clean'));
  assert.equal(result.inventory.find((item) => item.name === 'gamemd.exe').matches[0].path, 'GAMEMD.EXE');
  assert.equal(result.inventory.find((item) => item.name === 'yuri.exe').present, false);
  assert.equal(result.skipped.length, 2);
  for (const name of ['linked-content', 'cycle']) {
    assert.ok(result.skipped.some((message) => message.startsWith(name + ':') && /not traversed/i.test(message)));
  }
  assert.deepEqual(result.errors, []);
  assert.equal((await stat(target, { bigint: true })).mtimeNs, before.mtimeNs);
  assert.deepEqual(await readFile(target), bytes);
});

test('CLI prints a summary, writes only an external JSON report, and rejects an internal report', async (t) => {
  const directory = await temporaryDirectory(t);
  const gameDir = path.join(directory, 'game');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'gamemd.exe'), makePE());
  await writeFile(path.join(gameDir, 'unrecognized.dat'), 'preserve this unrelated game file');
  const before = await snapshot(gameDir);
  const output = path.join(directory, 'report.json');
  const run = spawnSync(process.execPath, [cli, gameDir, '--json', output], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /gamemd\.exe/i);
  assert.match(run.stdout, /YR exe:/i);
  assert.ok(JSON.parse(await readFile(output, 'utf8')).inventory.length > 0);
  assert.deepEqual(await snapshot(gameDir), before);
  const existingContents = await readFile(output, 'utf8');
  const existing = spawnSync(process.execPath, [cli, gameDir, '--json', output], { encoding: 'utf8' });
  assert.notEqual(existing.status, 0);
  assert.equal(await readFile(output, 'utf8'), existingContents);
  const forbidden = spawnSync(process.execPath, [cli, gameDir, '--json', path.join(gameDir, 'report.json')], {
    encoding: 'utf8',
  });
  assert.notEqual(forbidden.status, 0);
  assert.deepEqual(await snapshot(gameDir), before);
  await symlink(gameDir, path.join(directory, 'alias'));
  const alias = spawnSync(process.execPath, [cli, gameDir, '--json', path.join(directory, 'alias', 'report.json')], {
    encoding: 'utf8',
  });
  assert.notEqual(alias.status, 0);
  assert.deepEqual(await snapshot(gameDir), before);
  const protectedFile = path.join(gameDir, 'unrecognized.dat');
  for (const [name, createAlias] of [
    ['leaf-symlink.json', symlink],
    ['hardlink.json', link],
  ]) {
    const destination = path.join(directory, name);
    await createAlias(protectedFile, destination);
    const guarded = spawnSync(process.execPath, [cli, gameDir, '--json', destination], { encoding: 'utf8' });
    assert.notEqual(guarded.status, 0);
    assert.deepEqual(await snapshot(gameDir), before);
  }
});
