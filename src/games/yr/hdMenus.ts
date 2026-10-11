import type { MenuControlSnapshot, MenuSnapshot } from '../../vm86/menuSnapshot';

export type YrHdMenu = 'main' | 'options' | 'quit';
/** Original BKGDLG geometry; smaller surfaces require their own verified artwork/layout. */
export const YR_HD_DIALOG_ART_SIZE = { width: 856, height: 736 } as const;

const screens: { name: YrHdMenu; required: number[]; allowed: number[] }[] = [
  {
    name: 'main',
    required: [1667, 1668, 1400, 1670, 1372, 1006, 1684],
    allowed: [1667, 1668, 1400, 1670, 1372, 1006, 1684, 1685, 1818, 1820, 1821],
  },
  {
    name: 'options',
    required: [1670, 1313, 1310, 1314, 1311, 1312, 1684],
    allowed: [1670, 1313, 1310, 1314, 1311, 1312, 1684, 1685],
  },
  { name: 'quit', required: [1670, 1737, 65535], allowed: [1670, 1737, 65535, 1810, 1685] },
];

/** A complete known dialog is the unit of replacement, including disabled controls. */
export function identifyYrHdMenu(snapshot: MenuSnapshot): YrHdMenu | null {
  if (
    !snapshot.complete ||
    !Number.isFinite(snapshot.width) ||
    !Number.isFinite(snapshot.height) ||
    snapshot.width < 800 ||
    snapshot.height < 600
  )
    return null;
  const roots = snapshot.controls.filter((control) => control.hwnd === snapshot.dialogHwnd);
  const root = roots[0];
  if (
    roots.length !== 1 ||
    !root?.visible ||
    root.className !== '#32770' ||
    root.rect.x !== 0 ||
    root.rect.y !== 0 ||
    root.rect.width !== snapshot.width ||
    root.rect.height !== snapshot.height
  )
    return null;
  const controls = snapshot.controls.filter((control) => control.visible && control.hwnd !== snapshot.dialogHwnd);
  if (
    controls.some((control) => {
      const { x, y, width, height } = control.rect;
      return (
        !control.textComplete ||
        !['Button', 'Static'].includes(control.className) ||
        ![x, y, width, height].every(Number.isFinite) ||
        x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > snapshot.width ||
        y + height > snapshot.height
      );
    })
  )
    return null;
  for (const screen of screens) {
    if (
      screen.required.every((id) => controls.some((control) => control.id === id)) &&
      controls.every((control) => screen.allowed.includes(control.id)) &&
      (screen.name === 'main'
        ? snapshot.width === 800 && snapshot.height === 600
        : snapshot.width >= YR_HD_DIALOG_ART_SIZE.width && snapshot.height >= YR_HD_DIALOG_ART_SIZE.height)
    )
      return screen.name;
  }
  return null;
}

/** Resolve only actual control text and the supplied installation's string table. */
export function yrMenuText(control: MenuControlSnapshot, strings: Readonly<Record<string, string>>): string | null {
  const raw = control.text;
  // This template placeholder can hide live owner-drawn text even on a Static.
  // Only the game's text reader can establish an intentionally empty caption.
  if (/^gui:blank$/i.test(raw)) return null;
  if (!raw) return control.className !== 'Button' && control.sourceText !== undefined ? '' : null;
  const text = /^[a-z]+:/i.test(raw) ? strings[raw.toLowerCase()] : raw;
  if (text === undefined || (!text.trim() && control.className === 'Button')) return null;
  return text
    .replace(/&&/g, '\u0000')
    .replace(/&/g, '')
    .replace(/\u0000/g, '&');
}
