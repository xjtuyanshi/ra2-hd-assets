import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Conservatively reuse the repository's shared session resolution range, further
// bounded by the native picture protocol (agent/picture.c and NativePictureDecoder).
export const NATIVE_RESOLUTION_LIMITS = Object.freeze({
  minWidth: 800,
  minHeight: 600,
  maxWidth: 2560,
  maxHeight: 1600,
  maxPixels: 2 * 1024 * 1024,
});

export function parseNativeSize(value) {
  const match = /^(\d+)x(\d+)$/i.exec(value ?? '');
  if (!match) throw new Error('--size must be WxH, for example 1280x720');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 800 || height < 600)
    throw new Error('--size must be at least 800x600, with safe integer dimensions');
  return { width, height };
}

export function capNativeResolution(size) {
  const limits = NATIVE_RESOLUTION_LIMITS;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0)
    throw new Error('The main display did not provide a valid size in points; use --size WxH');
  let width = Math.min(limits.maxWidth, Math.max(limits.minWidth, Math.floor(size.width)));
  let height = Math.min(limits.maxHeight, Math.max(limits.minHeight, Math.floor(size.height)));
  const scale = Math.min(1, Math.sqrt(limits.maxPixels / (width * height)));
  width = Math.max(limits.minWidth, Math.floor(width * scale));
  height = Math.max(limits.minHeight, Math.floor(height * scale));
  // A very wide/tall display can hit the minimum after proportional capping.
  if (width * height > limits.maxPixels) {
    if (width === limits.minWidth) height = Math.floor(limits.maxPixels / width);
    else width = Math.floor(limits.maxPixels / height);
  }
  return { width, height };
}

export function mainDisplaySize() {
  if (process.platform !== 'darwin')
    throw new Error('Automatic main-display sizing is supported on macOS; use --size WxH');
  // The first NSScreen is the primary display, with its menu bar. Its frame is
  // expressed in points, so Retina pixels are never mistaken for game pixels.
  const script = `ObjC.import('AppKit');
const screens = $.NSScreen.screens;
if (!screens.count) throw new Error('No primary display is available to this process');
const screen = screens.objectAtIndex(0);
const frame = screen.frame;
JSON.stringify({width:frame.size.width,height:frame.size.height});`;
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.status !== 0)
    throw new Error(
      `Could not measure the main display in points; use --size WxH (${result.stderr?.trim() || 'osascript failed'})`,
    );
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('Could not parse the main display size; use --size WxH');
  }
}

/** Change only native startup resolution keys; preserve ANSI bytes and line endings. */
export function patchNativeResolutionIni(bytes, size) {
  const original = Buffer.from(bytes);
  const unicodeBoms = [
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0xfe, 0xff]),
    Buffer.from([0, 0, 0xfe, 0xff]),
  ];
  if (unicodeBoms.some((bom) => original.subarray(0, bom.length).equals(bom)))
    throw new Error('Unicode BOM game INI is unsupported; leaving the file unchanged');
  const text = original.toString('latin1');
  const newline = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
  if (!text.trim())
    return Buffer.from(
      `[Video]${newline}ScreenWidth=${size.width}${newline}ScreenHeight=${size.height}${newline}AllowHiResModes=yes${newline}`,
      'latin1',
    );
  const trailingNewline = /(?:\r\n|\n|\r)$/.test(text);
  const values = { screenwidth: String(size.width), screenheight: String(size.height), allowhiresmodes: 'yes' };
  const names = { screenwidth: 'ScreenWidth', screenheight: 'ScreenHeight', allowhiresmodes: 'AllowHiResModes' };
  const found = new Set();
  let inVideo = false;
  let firstVideo = -1;
  const lines = text.split(/\r\n|\n|\r/);
  if (trailingNewline) lines.pop();
  for (let index = 0; index < lines.length; index++) {
    const section = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(lines[index]);
    if (section) {
      inVideo = section[1].trim().toLowerCase() === 'video';
      if (inVideo && firstVideo < 0) firstVideo = index;
    } else if (inVideo) {
      const key = /^(\s*)([^=;#]+?)(\s*=\s*)([^;#]*)(.*)$/.exec(lines[index]);
      const normalized = key?.[2].trim().toLowerCase();
      if (normalized && Object.hasOwn(values, normalized)) {
        found.add(normalized);
        const trailing = key[4].match(/\s*$/)[0];
        lines[index] = `${key[1]}${key[2]}${key[3]}${values[normalized]}${trailing}${key[5]}`;
      }
    }
  }
  if (firstVideo < 0) {
    if (lines.at(-1)?.trim()) lines.push('');
    firstVideo = lines.length;
    lines.push('[Video]');
  }
  let end = lines.findIndex((line, index) => index > firstVideo && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  for (const key of Object.keys(values)) {
    if (!found.has(key)) lines.splice(end++, 0, `${names[key]}=${values[key]}`);
  }
  return Buffer.from(lines.join(newline) + (trailingNewline ? newline : ''), 'latin1');
}

export function nativeResolutionIniName(names) {
  const matches = names.filter((name) => name.toLowerCase() === 'ra2md.ini');
  if (matches.length > 1)
    throw new Error('Multiple case variants of RA2MD.INI exist; refusing an ambiguous game-setting rewrite');
  return matches[0] ?? 'RA2MD.INI';
}

export async function configureNativeResolution(gameDirectory, runDirectory, size) {
  const existingName = nativeResolutionIniName(await readdir(gameDirectory));
  const target = join(gameDirectory, existingName ?? 'RA2MD.INI');
  const stat = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isFile()) throw new Error(`Refusing to rewrite a non-regular game INI: ${target}`);
  const original = stat ? await readFile(target) : Buffer.alloc(0);
  const patched = patchNativeResolutionIni(original, size);
  if (original.equals(patched)) return { target, backup: null, changed: false };
  let backup = null;
  if (stat) {
    backup = join(runDirectory, 'RA2MD.original.ini');
    await copyFile(target, backup, constants.COPYFILE_EXCL);
    if (!original.equals(await readFile(backup))) throw new Error('Game INI changed during backup; leaving it alone');
  }
  const staging = join(dirname(target), `.native-resolution-${randomUUID()}.ini`);
  try {
    await writeFile(staging, patched, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o600 });
    if (stat) await chmod(staging, stat.mode & 0o777);
    const current = await lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat ? !current?.isFile() || current.dev !== stat.dev || current.ino !== stat.ino : current !== null)
      throw new Error('Game INI was replaced during configuration; leaving it alone');
    if (stat && !original.equals(await readFile(target)))
      throw new Error('Game INI changed during configuration; leaving it alone');
    if (stat) await rename(staging, target);
    else await link(staging, target); // A concurrent new INI must never be overwritten.
  } finally {
    await unlink(staging).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { target, backup, changed: true };
}

// Read-only runner probe: no game, browser, settings or files are changed.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const points = mainDisplaySize();
  console.log(JSON.stringify({ points, native: capNativeResolution(points) }));
}
