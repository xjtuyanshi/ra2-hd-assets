import { describe, expect, it } from 'vitest';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { type GameSource } from '../../src/games/source';
import { supportedGame } from '../../src/games/catalog';
import { gameResolutionIni, withGameResolutionOverride } from '../../src/games/resolution';
import { withMultiplayerNameOverride } from '../../src/games/multiplayerName';
import {
  parseGameSpeed,
  patchGameSpeedIni,
  withGameSpeedDefault,
  withGameSpeedOverride,
} from '../../src/games/gameSpeed';

const encode = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const decode = (b: Uint8Array) => String.fromCharCode(...b);

describe('原版启动速度', () => {
  it('只更新单机速度，保留联机设置、编码和 CRLF，清理重复键', () => {
    const original =
      '[Options]\r\nGameSpeed=2\r\ngamespeed=3\r\n;\xff\r\n[Skirmish]\r\nGameSpeed=1\r\n[LAN]\r\nGameSpeed=4\r\n';
    const result = decode(patchGameSpeedIni(encode(original), 0));
    expect(result).toBe('[Options]\r\nGameSpeed=0\r\n;\xff\r\n[Skirmish]\r\nGameSpeed=0\r\n[LAN]\r\nGameSpeed=4\r\n');
  });
  it('空配置补齐节，已有节补齐键，并拒绝非原版档位', () => {
    expect(decode(patchGameSpeedIni(new Uint8Array(), 0))).toBe('[Options]\nGameSpeed=0\n[Skirmish]\nGameSpeed=0\n');
    expect(decode(patchGameSpeedIni(encode('[Options]\nVolume=1\n[Video]\n'), 6))).toContain(
      'Volume=1\nGameSpeed=6\n[Video]',
    );
    for (const speed of [-1, 7, 0.5, NaN, Infinity]) expect(() => patchGameSpeedIni(new Uint8Array(), speed)).toThrow();
  });
  it.each(['ra2', 'yr'] as const)('%s 默认最快，与分辨率/名字叠加且不写回导入包', async (id) => {
    const path = gameResolutionIni(id),
      original = encode('[Options]\nGameSpeed=2\n');
    const files = new MemoryGameFileProvider(new Map([[path, original]]));
    const source: GameSource = { game: supportedGame(id), files, executableBytes: new Uint8Array([1]) };
    expect(source.game.defaultGameSpeed).toBe(0);
    expect(source.game.commandLineArguments).toBe('-SPEEDCONTROL');
    const configured = await withGameSpeedDefault(
      await withMultiplayerNameOverride(
        await withGameResolutionOverride(source, { width: 1440, height: 900 }),
        'Alice',
      ),
    );
    const ini = decode((await configured.files.read(path))!);
    expect(ini).toContain('GameSpeed=0');
    expect(ini).toContain('ScreenWidth=1440');
    expect(ini).toContain('Handle=41,6c,69,63,65,');
    await configured.files.write(path, encode('[Options]\nGameSpeed=3\n'));
    expect(await files.read(path)).toEqual(original);
    const generic = { ...source, game: { ...source.game, defaultGameSpeed: undefined } };
    expect(await withGameSpeedDefault(generic)).toBe(generic);
  });
  it('本次会话指定的速度取代目录默认值，只进内存覆盖层；非原版档位不算请求', async () => {
    const path = gameResolutionIni('yr'),
      original = encode('[Options]\nGameSpeed=2\n[LAN]\nGameSpeed=4\n');
    const files = new MemoryGameFileProvider(new Map([[path, original]]));
    const source: GameSource = { game: supportedGame('yr'), files, executableBytes: new Uint8Array([1]) };
    // The startup chain of the Worker and of the main thread: resolution, name, then the core's speed default.
    const startupIni = async (from: GameSource) => {
      const named = await withMultiplayerNameOverride(
        await withGameResolutionOverride(from, { width: 1728, height: 1080 }),
        'Bob',
      );
      return decode((await (await withGameSpeedDefault(named)).files.read(path))!);
    };
    expect(withGameSpeedOverride(source, undefined)).toBe(source);
    expect(withGameSpeedOverride(source, null)).toBe(source);
    const catalog = await startupIni(source);
    const chosen = await startupIni(withGameSpeedOverride(source, 3));
    expect(catalog.match(/GameSpeed=0/g)).toHaveLength(2);
    expect(chosen).toBe(catalog.replaceAll('GameSpeed=0', 'GameSpeed=3'));
    expect(chosen).toContain('[LAN]\nGameSpeed=4');
    expect(source.game.defaultGameSpeed).toBe(0);
    expect(await files.read(path)).toEqual(original);
    // A game without a catalog default still honours the session's choice.
    const generic = withGameSpeedOverride({ ...source, game: { ...source.game, defaultGameSpeed: undefined } }, 4);
    expect(decode((await (await withGameSpeedDefault(generic)).files.read(path))!)).toContain('[Options]\nGameSpeed=4');
    for (const speed of [-1, 7, 2.5, NaN]) expect(() => withGameSpeedOverride(source, speed)).toThrow();
    expect(['0', '3', '6'].map((value) => parseGameSpeed(value))).toEqual([0, 3, 6]);
    for (const value of [null, undefined, '', '7', '-1', '3.0', ' 3', 'normal'])
      expect(parseGameSpeed(value)).toBeUndefined();
  });
});
