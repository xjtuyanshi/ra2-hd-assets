import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ } from '../helpers/guestMemory';

describe('window enumeration in Z order', () => {
  function setup(gameId?: 'ra2' | 'yr') {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId });
    writeAsciiZ(memory, 0x300000, 'Static');
    const create = (parent = 0, controlId = 0) =>
      callShim(shim, 'USER32.DLL!CreateWindowExA', [
        0,
        0x300000,
        0,
        parent ? 0x50000000 : 0x10000000,
        0,
        0,
        100,
        40,
        parent,
        controlId,
        0,
        0,
      ]).eax;
    const get = (hwnd: number, relation: number) => callShim(shim, 'USER32.DLL!GetWindow', [hwnd, relation]).eax;
    const top = (parent: number) => callShim(shim, 'USER32.DLL!GetTopWindow', [parent]).eax;
    const move = (hwnd: number, after: number) =>
      callShim(shim, 'USER32.DLL!SetWindowPos', [hwnd, after, 0, 0, 0, 0, 0x13]);
    return { shim, memory, create, get, top, move };
  }

  it('shows movie controls only with decoder playback and no actually visible shell page', () => {
    const { shim, memory, create } = setup('yr');
    const decoder = shim as unknown as { nativeBinkPlaybackActive: boolean; shellPageTitle: string };
    decoder.nativeBinkPlaybackActive = true;
    expect(shim.inspectMoviePlayback()).toBe(true);
    const menu = create();
    const title = create(menu, 1684);
    writeAsciiZ(memory, 0x310000, 'GUI:MainMenu');
    callShim(shim, 'USER32.DLL!SetWindowTextA', [title, 0x310000]);
    // The actual dialog parser records this title; this fixture isolates its
    // visibility ancestry from decoder execution and resource templates.
    decoder.shellPageTitle = 'GUI:MainMenu';
    expect(shim.inspectMoviePlayback()).toBe(false);
    callShim(shim, 'USER32.DLL!ShowWindow', [menu, 0]);
    expect(shim.inspectMoviePlayback()).toBe(true);
    callShim(shim, 'USER32.DLL!ShowWindow', [menu, 5]);
    expect(shim.inspectMoviePlayback()).toBe(false);
    decoder.nativeBinkPlaybackActive = false;
    callShim(shim, 'USER32.DLL!ShowWindow', [menu, 0]);
    expect(shim.inspectMoviePlayback()).toBe(false);
  });

  it('enumerates the save confirmation above its older sibling page, excluding other parents', () => {
    const { create, get, top } = setup();
    const parent = create();
    const page = create(parent);
    const modal = create(parent);
    const button = create(modal);
    const unrelated = create();
    expect(top(parent)).toBe(modal);
    expect(get(parent, 5)).toBe(modal);
    expect(get(page, 0)).toBe(modal);
    expect(get(modal, 1)).toBe(page);
    expect(get(modal, 2)).toBe(page);
    expect(get(page, 3)).toBe(modal);
    expect(get(page, 2)).toBe(0);
    expect(get(modal, 3)).toBe(0);
    expect(top(modal)).toBe(button);
    expect(top(button)).toBe(0);
    expect(top(0)).toBe(unrelated);
    expect(get(unrelated, 2)).toBe(parent);
  });

  it('follows subsequent reordering and destruction instead of creation order', () => {
    const { shim, create, get, top, move } = setup();
    const parent = create();
    const first = create(parent);
    const second = create(parent);
    const third = create(parent);
    move(first, 0); // HWND_TOP
    expect(top(parent)).toBe(first);
    expect(get(parent, 5)).toBe(first);
    expect(get(first, 2)).toBe(third);
    move(first, 1); // HWND_BOTTOM
    expect(top(parent)).toBe(third);
    expect(get(third, 1)).toBe(first);
    expect(get(second, 2)).toBe(first);
    callShim(shim, 'USER32.DLL!DestroyWindow', [third]);
    expect(top(parent)).toBe(second);
    expect(get(parent, 5)).toBe(second);
    for (const relation of [0, 1, 2, 3, 5, 6]) expect(get(third, relation)).toBe(0);
  });
});
