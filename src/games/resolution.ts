import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameSource } from './source';
import type { SupportedGameId } from './catalog';

export interface GameResolution {
  width: number;
  height: number;
}

export const GAME_RESOLUTIONS: readonly GameResolution[] = [
  { width: 800, height: 600 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

/**
 * Sizes a session overlay may request outside the presets: at least the 800x600 the games' shell pages are laid out
 * for, at most what the VM's display-mode shim accepts (SetDisplayMode in src/vm86/shim/directx.ts).
 */
export const GAME_RESOLUTION_LIMITS = { minWidth: 800, minHeight: 600, maxWidth: 2560, maxHeight: 1600 } as const;

/** A whole-pixel size within GAME_RESOLUTION_LIMITS (a preset or not), or null. */
export function customGameResolution(width: number, height: number): GameResolution | null {
  const { minWidth, minHeight, maxWidth, maxHeight } = GAME_RESOLUTION_LIMITS;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < minWidth || width > maxWidth || height < minHeight || height > maxHeight) return null;
  return { width, height };
}

export function gameResolutionValue(resolution: GameResolution): string {
  return `${resolution.width}x${resolution.height}`;
}

export function parseGameResolution(value: string | null): GameResolution | null {
  if (!value) return null;
  return GAME_RESOLUTIONS.find((resolution) => gameResolutionValue(resolution) === value) ?? null;
}

export function gameResolutionIni(gameId: SupportedGameId): string {
  return gameId === 'yr' ? 'RA2MD.INI' : 'RA2.INI';
}

const bytesToLatin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return text;
};

const latin1ToBytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
};

/** Preserve the original INI byte encoding and other settings; override only resolution keys in [Video]. */
export function patchGameResolutionIni(bytes: Uint8Array, resolution: GameResolution): Uint8Array {
  const text = bytesToLatin1(bytes);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (!text.trim()) {
    // If no source INI exists in the online package, generate properly formatted configuration. Leading blank lines or
    // missing trailing newlines make the native INI parser skip [Video], observed to fall back to a 640x400 intro
    // and hang because the transition path cannot exit with a zero-byte movies01.mix.
    return latin1ToBytes(
      `[Video]${newline}AllowHiResModes=yes${newline}` +
        `ScreenWidth=${resolution.width}${newline}ScreenHeight=${resolution.height}${newline}`,
    );
  }
  const trailingNewline = /(?:\r\n|\n|\r)$/.test(text);
  const lines = text.split(/\r\n|\n|\r/);
  if (trailingNewline) lines.pop();

  let videoStart = lines.findIndex((line) => /^\s*\[video\]\s*$/i.test(line));
  if (videoStart < 0) {
    if (lines.length && lines.at(-1)?.trim()) lines.push('');
    videoStart = lines.length;
    lines.push('[Video]');
  }
  let videoEnd = lines.findIndex((line, index) => index > videoStart && /^\s*\[[^\]]+\]\s*$/.test(line));
  if (videoEnd < 0) videoEnd = lines.length;

  const values: Readonly<Record<string, string>> = {
    allowhiresmodes: 'yes',
    screenwidth: String(resolution.width),
    screenheight: String(resolution.height),
  };
  for (const [normalizedKey, value] of Object.entries(values)) {
    const lineIndex = lines.findIndex((line, index) => {
      if (index <= videoStart || index >= videoEnd) return false;
      const match = line.match(/^\s*([^=;#]+?)\s*=/);
      return match?.[1]?.trim().toLowerCase() === normalizedKey;
    });
    const canonicalKey =
      normalizedKey === 'allowhiresmodes'
        ? 'AllowHiResModes'
        : normalizedKey === 'screenwidth'
          ? 'ScreenWidth'
          : 'ScreenHeight';
    if (lineIndex >= 0) lines[lineIndex] = `${canonicalKey}=${value}`;
    else {
      lines.splice(videoEnd, 0, `${canonicalKey}=${value}`);
      videoEnd++;
    }
  }
  return latin1ToBytes(lines.join(newline) + (trailingNewline ? newline : ''));
}

/** Default menu resolution when an online package has no INI: the standard RA2 menu setting. */
const FALLBACK_RESOLUTION: GameResolution = { width: 800, height: 600 };

/** Read the INI actually used by the game, then overlay a read-only memory layer; if unreadable, provide an openable empty configuration. */
export async function withGameResolutionOverride(
  source: GameSource,
  resolution: GameResolution | null | undefined,
): Promise<GameSource> {
  const iniPath = gameResolutionIni(source.game.id);
  const original = await source.files.read(iniPath);
  // Use an existing INI unchanged if no modification was requested, preserving the player's settings and resolution.
  if (!resolution && original !== null) return source;
  // Without an INI in the online package, supply a properly formatted default even without a resolution request; missing,
  // empty, or leading-blank-line INIs cause an observed 640x400 intro fallback and hang.
  const applied = resolution ?? FALLBACK_RESOLUTION;
  const patched = patchGameResolutionIni(original ?? new Uint8Array(), applied);
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[iniPath, patched]]),
      resolution ? `（内存分辨率 ${applied.width}×${applied.height}）` : '（内存默认配置）',
      true,
    ),
  };
}
