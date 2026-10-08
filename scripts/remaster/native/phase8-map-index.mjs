#!/usr/bin/env node
// Phase 8's prepared native copy has a runner-created, one-map loose index.
// Removing only those verified bytes restores the player's archive precedence.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOT = resolve(WT, '../..');
const OUT = join(ROOT, 'gameres/s2x/native');
const nativeDirectory = join(ROOT, 'gameres/native-dev/YURI');
const emulatorDirectory = join(ROOT, 'game/ra2');
const target = join(nativeDirectory, 'missionsmd.pkt');
const backupDirectory = join(OUT, 'phase8/map-index-backup');
const backup = join(backupDirectory, 'missionsmd.pkt');
const manifestPath = join(backupDirectory, 'manifest.json');
const overrideSha256 = 'a3703a8491b5fb4b6751ed0a8561aa857c2a6f53708d98ff36c5377564029891';
const identityFiles = [
  ['gamemd.exe', '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6'],
  ['langmd.mix', 'a7962ebad4bc7bfdadeb9e8800cdb5d159972f04c755865624029fae67e44789'],
  ['multimd.mix', 'ff4138ba95f7efd8bded14342fc9082b99c47e43c25ab18236e4eea141b488e9'],
  ['mapsmd03.mix', '6c36a0af05e2e9f86967308c77cf90fae9976d920e320aad8b9e4aa2e99e86a3'],
  ['ra2md.mix', '69d886defad9114dd440a013b364c8c004e369b5221d1889957b49d00058559d'],
];

async function regularFile(path, optional = false) {
  const stat = await lstat(path).catch((error) => {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isFile()) throw new Error(`Expected a regular file, refusing: ${path}`);
  return stat;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function verifyScope() {
  // The immutable emulator directory is read for comparison only. Neither an
  // environment variable nor a command-line path can redirect the mutation.
  const [nativeReal, emulatorReal] = await Promise.all([realpath(nativeDirectory), realpath(emulatorDirectory)]);
  if (nativeReal !== nativeDirectory || emulatorReal === nativeReal)
    throw new Error('The prepared native copy is redirected or aliases the emulator directory');
  if (
    await lstat(join(emulatorDirectory, 'missionsmd.pkt')).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })
  )
    throw new Error('The emulator has a loose missionsmd.pkt; the recorded precedence comparison no longer applies');
  const files = await Promise.all(
    identityFiles.map(async ([file, expected]) => {
      const paths = [join(nativeDirectory, file), join(emulatorDirectory, file)];
      await Promise.all(paths.map((path) => regularFile(path)));
      const hashes = await Promise.all(paths.map(sha256));
      if (hashes.some((hash) => hash !== expected))
        throw new Error(`Prepared/native and emulator asset identity changed: ${file}`);
      return { file, sha256: expected, equal: true };
    }),
  );
  return files;
}

async function verifiedOverride(path) {
  const stat = await regularFile(path, true);
  if (!stat) return null;
  const hash = await sha256(path);
  if (hash !== overrideSha256) throw new Error(`Refusing unknown missionsmd.pkt bytes (${hash}): ${path}`);
  return { stat, sha256: hash };
}

async function ensureBackupDirectory() {
  if ((await realpath(OUT)) !== OUT) throw new Error('The artifact directory is redirected; refusing writes');
  for (const directory of [join(OUT, 'phase8'), backupDirectory]) {
    const stat = await lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) await mkdir(directory);
    else if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Artifact directory is not an ordinary directory: ${directory}`);
    if ((await realpath(directory)) !== directory) throw new Error(`Artifact directory is redirected: ${directory}`);
  }
}

async function removeOverride() {
  const current = await verifiedOverride(target);
  if (!current) return { changed: false, reason: 'No loose override; original archive precedence is active' };
  await ensureBackupDirectory();
  const retained = await verifiedOverride(backup);
  if (!retained) await copyFile(target, backup, constants.COPYFILE_EXCL);
  await verifiedOverride(backup);
  const manifest = {
    schema: 1,
    target,
    backup,
    sha256: overrideSha256,
    bytes: current.stat.size,
    reason: 'Runner-created one-map missionsmd.pkt overrides the unchanged player-owned archive index',
  };
  const priorManifest = (await regularFile(manifestPath, true)) ? await readFile(manifestPath, 'utf8') : null;
  if (priorManifest) {
    const prior = JSON.parse(priorManifest);
    for (const key of ['schema', 'target', 'backup', 'sha256', 'bytes'])
      if (prior[key] !== manifest[key]) throw new Error(`Existing backup manifest differs: ${key}`);
  } else await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const unchanged = await verifiedOverride(target);
  if (!unchanged || unchanged.stat.dev !== current.stat.dev || unchanged.stat.ino !== current.stat.ino)
    throw new Error('Loose index changed during backup; leaving it alone');
  await unlink(target);
  return { changed: true, reason: 'Removed the verified one-map loose override', backup, manifestPath };
}

async function restoreOverride() {
  await ensureBackupDirectory();
  await regularFile(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.schema !== 1 ||
    manifest.target !== target ||
    manifest.backup !== backup ||
    manifest.sha256 !== overrideSha256
  )
    throw new Error('Backup manifest is outside the recorded prepared-copy scope');
  const retained = await verifiedOverride(backup);
  if (!retained || retained.stat.size !== manifest.bytes) throw new Error('Backup is missing or changed');
  const current = await verifiedOverride(target);
  if (current) return { changed: false, reason: 'The verified one-map override is already present' };
  await copyFile(backup, target, constants.COPYFILE_EXCL);
  await verifiedOverride(target);
  return { changed: true, reason: 'Restored the verified loose override from its retained backup', backup };
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !['--inventory', '--remove-one-map-override', '--restore'].includes(args[0])))
  throw new Error('Usage: phase8-map-index.mjs [--inventory|--remove-one-map-override|--restore]');
const operation = args[0] ?? '--inventory';
const files = await verifyScope();
const index = await verifiedOverride(target);
const result =
  operation === '--remove-one-map-override'
    ? await removeOverride()
    : operation === '--restore'
      ? await restoreOverride()
      : { changed: false, reason: 'Read-only inventory' };
const report = {
  recordedAt: new Date().toISOString(),
  operation,
  nativeDirectory,
  emulatorDirectory,
  identityFiles: files,
  looseIndexBefore: index ? { sha256: index.sha256, bytes: index.stat.size } : null,
  ...result,
  note: 'Archive membership and mode filtering require the live map dialog; this command makes no UI count claim.',
};
if (operation !== '--inventory') {
  await ensureBackupDirectory();
  report.evidenceFile = join(
    backupDirectory,
    `${operation === '--restore' ? 'restore' : 'removal'}-${Date.now()}-${randomUUID()}.json`,
  );
  await writeFile(report.evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
