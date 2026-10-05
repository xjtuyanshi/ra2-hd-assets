import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameSource } from './source';
import { gameResolutionIni } from './resolution';

/** Original scale: 0 fastest, 6 slowest. Set only the startup default, without changing clocks or overriding the multiplayer host's speed. */
export function patchGameSpeedIni(bytes: Uint8Array, speed: number): Uint8Array {
  if (!Number.isInteger(speed) || speed < 0 || speed > 6) throw new Error('游戏速度必须为 0–6 的整数');
  let text = '';
  for (let i = 0; i < bytes.length; i += 4096) text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r\n|\n|\r/) : [];
  const result: string[] = [];
  const found = new Set<string>();
  let section = '',
    written = false;
  const finish = () => {
    if (section && !written) result.push(`GameSpeed=${speed}`);
  };
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) {
      finish();
      const name = match[1]!.toLowerCase();
      section = name === 'options' || name === 'skirmish' ? name : '';
      written = false;
      if (section) found.add(section);
    }
    if (section && /^\s*GameSpeed\s*=/i.test(line)) {
      // Remove duplicate keys in the same section so the native parser cannot read old defaults.
      if (!written) result.push(`GameSpeed=${speed}`);
      written = true;
    } else result.push(line);
  }
  finish();
  for (const name of ['Options', 'Skirmish']) {
    if (!found.has(name.toLowerCase())) result.push(`[${name}]`, `GameSpeed=${speed}`);
  }
  if (result.at(-1) !== '') result.push('');
  return Uint8Array.from(result.join(newline), (c) => c.charCodeAt(0));
}

/** `?game-speed=`: one original INI speed (0 fastest to 6 slowest); anything else is no request. */
export function parseGameSpeed(value: string | null | undefined): number | undefined {
  return value !== null && value !== undefined && /^[0-6]$/.test(value) ? Number(value) : undefined;
}

/**
 * A session's own startup speed (a launcher that opens the skirmish setup at normal speed) in place of the catalog
 * default. Only records the choice: withGameSpeedDefault writes it, in the Worker and on the main thread alike.
 */
export function withGameSpeedOverride(source: GameSource, speed: number | null | undefined): GameSource {
  if (speed === null || speed === undefined) return source;
  if (!Number.isInteger(speed) || speed < 0 || speed > 6) throw new Error('游戏速度必须为 0–6 的整数');
  return { ...source, gameSpeed: speed };
}

/** Shared by Workers/main thread before guest creation; like resolution/name overrides, affects only this startup and never modifies imported packages. */
export async function withGameSpeedDefault(source: GameSource): Promise<GameSource> {
  const speed = source.gameSpeed ?? source.game.defaultGameSpeed;
  if (speed === undefined) return source;
  const path = gameResolutionIni(source.game.id);
  const original = (await source.files.read(path)) ?? new Uint8Array();
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[path, patchGameSpeedIni(original, speed)]]),
      '（内存默认游戏速度）',
      true,
    ),
  };
}
