import type { MenuControlSnapshot, MenuSnapshot } from '../../vm86/menuSnapshot';

export type YrHdMenu = 'main' | 'options' | 'quit' | 'setup' | 'choose-map';
/** Original BKGDLG geometry; smaller surfaces require their own verified artwork/layout. */
export const YR_HD_DIALOG_ART_SIZE = { width: 856, height: 736 } as const;

/** Win32 templates encode IDC_STATIC as either WORD -1 or DWORD -1. Keep the
 * captured ID intact and compare only these label sentinels in menu policy. */
export function yrMenuControlId(control: Pick<MenuControlSnapshot, 'id' | 'className'>): number {
  return control.className.toLowerCase() === 'static' && (control.id === -1 || control.id === 0xffff_ffff)
    ? 65535
    : control.id;
}

const setupColors = [1698, 1314, 1315, 1316, 1317, 1318, 1319, 1320];
const setupCombos = [
  1697,
  1291,
  1294,
  1296,
  1302,
  1306,
  1307,
  1308,
  1309,
  1300,
  1310,
  1311,
  1312,
  1299,
  1313,
  ...setupColors,
  1699,
  1700,
  1701,
  1702,
  1703,
  1704,
  1706,
  1707,
  1901,
  1902,
  1903,
  1904,
  1905,
  1906,
  1907,
  1908,
];
const setupStatics = [
  1684, 1689, 1691, 1692, 1754, 1755, 1756, 1757, 1758, 1759, 1760, 1761, 1772, 1685, 1128, 1448, 1942, 1937, 1938,
  1939, 1940,
];
const setupChecks = [1686, 1683, 1358, 1690, 1693];
const setupSliders = [1292, 1297, 1321];
const setupRows = [1696, 1291, 1294, 1302, 1306, 1307, 1308, 1309].map((name, row) => [
  name,
  [1697, 1296, 1299, 1310, 1300, 1311, 1312, 1313][row]!,
  setupColors[row]!,
  [1699, 1700, 1701, 1702, 1703, 1704, 1706, 1707][row]!,
  1901 + row,
  1754 + row,
]);

function inside(rect: MenuControlSnapshot['rect'], container: MenuControlSnapshot['rect']): boolean {
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= container.x &&
    rect.y >= container.y &&
    rect.x + rect.width <= container.x + container.width &&
    rect.y + rect.height <= container.y + container.height
  );
}

/** Each custom popup must be tied to the game's actual owning ComboBox.
 * The list and scrollbar are siblings; guessing from overlapping rectangles
 * could cover an unrelated new window while retaining old menu controls. */
function pairedPopupControls(snapshot: MenuSnapshot, controls: MenuControlSnapshot[]): Set<number> | null {
  const paired = new Set<number>();
  const open = controls.filter((control) => control.popup?.dropped);
  if (
    open.length > 1 ||
    controls.some((control) => control.popup !== undefined && control.className.toLowerCase() !== 'combobox')
  )
    return null;
  const bounds = { x: 0, y: 0, width: snapshot.width, height: snapshot.height };
  for (const combo of open) {
    const popup = combo.popup!;
    if (
      combo.className.toLowerCase() !== 'combobox' ||
      !inside(popup.rect, bounds) ||
      !Number.isInteger(popup.selection) ||
      popup.selection! < -1 ||
      popup.selection! >= (combo.items?.length ?? 0) ||
      !Number.isInteger(popup.topIndex) ||
      popup.topIndex < 0 ||
      popup.topIndex > Math.max(0, (combo.items?.length ?? 0) - 1) ||
      !Number.isInteger(popup.hwnd) ||
      !popup.hwnd ||
      !Number.isInteger(popup.scrollbarHwnd) ||
      popup.scrollbarHwnd! < 0
    )
      return null;
    const list = controls.find((control) => control.hwnd === popup.hwnd);
    const bar = controls.find((control) => control.hwnd === popup.scrollbarHwnd);
    if (
      !list ||
      list.className.toLowerCase() !== 'combodropwin' ||
      list.id !== 0 ||
      list.popupOwner !== combo.hwnd ||
      list.parent !== combo.parent ||
      !['x', 'y', 'width', 'height'].every(
        (key) => list.rect[key as keyof typeof list.rect] === popup.rect[key as keyof typeof popup.rect],
      )
    )
      return null;
    if (popup.scrollbarHwnd === 0) {
      // The game allocates a sibling scrollbar only when the popup needs one.
      // Explicit zero is known absence; a missing field is still incomplete.
      if (list.rect.width !== combo.rect.width) return null;
    } else {
      if (
        !bar ||
        list.hwnd === bar.hwnd ||
        bar.parent !== combo.parent ||
        bar.className.toLowerCase() !== 'scrollbar' ||
        !knownControl('choose-map', bar) ||
        bar.rect.x !== list.rect.x + list.rect.width ||
        bar.rect.y !== list.rect.y ||
        bar.rect.height !== list.rect.height ||
        list.rect.width + bar.rect.width !== combo.rect.width
      )
        return null;
      paired.add(bar.hwnd);
    }
    paired.add(list.hwnd);
  }
  if (controls.some((control) => control.popupOwner !== undefined && !paired.has(control.hwnd))) return null;
  return paired;
}

/** These complete game-drawn images remain inside apertures in the HD shell. */
export function yrMenuNativeArtControl(screen: YrHdMenu, id: number): boolean {
  return (
    (screen === 'main' && id === 1820) ||
    ((screen === 'setup' || screen === 'choose-map') && id === 1128) ||
    (screen === 'setup' && id >= 1754 && id <= 1761)
  );
}

export function yrMenuCheckControl(screen: YrHdMenu, id: number): boolean {
  return screen === 'setup' && setupChecks.includes(id);
}

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
  {
    name: 'setup',
    required: [1696, 1697, 1698, 1699, 1901, 1559, 1450, 1472, 1128, ...setupChecks, ...setupSliders],
    allowed: [1696, 1559, 1450, 1472, ...setupCombos, ...setupStatics, ...setupChecks, ...setupSliders],
  },
  {
    name: 'choose-map',
    required: [1363, 1771, 1472, 1733, 1411, 1684, 1128],
    allowed: [1363, 1771, 1472, 1733, 1411, 1684, 65535, 1685, 1128, 0],
  },
];

/** A complete known dialog is the unit of replacement, including disabled controls. */
export function identifyYrHdMenu(snapshot: MenuSnapshot): YrHdMenu | null {
  if (
    !snapshot.complete ||
    !Number.isFinite(snapshot.width) ||
    !Number.isFinite(snapshot.height) ||
    snapshot.width < 800 ||
    snapshot.height < 600 ||
    new Set(snapshot.controls.map((control) => control.hwnd)).size !== snapshot.controls.length
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
  const controls = snapshot.controls
    .filter((control) => control.visible && control.hwnd !== snapshot.dialogHwnd)
    .map((control) => {
      const id = yrMenuControlId(control);
      return id === control.id ? control : { ...control, id };
    });
  if (
    controls.some((control) => {
      const { x, y, width, height } = control.rect;
      return (
        !control.textComplete ||
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
  const paired = pairedPopupControls(snapshot, controls);
  if (!paired) return null;
  const ordinary = controls.filter((control) => !paired.has(control.hwnd));
  for (const screen of screens) {
    if (
      screen.required.every((id) => ordinary.some((control) => control.id === id)) &&
      ordinary.every((control) => screen.allowed.includes(control.id)) &&
      ordinary.every((control) => knownControl(screen.name, control)) &&
      (screen.name !== 'setup' ||
        setupRows.every(
          (row) =>
            !row.some((id) => controls.some((control) => control.id === id)) ||
            row.every((id) => controls.filter((control) => control.id === id).length === 1),
        )) &&
      (['main', 'setup', 'choose-map'].includes(screen.name)
        ? snapshot.width === 800 && snapshot.height === 600
        : snapshot.width >= YR_HD_DIALOG_ART_SIZE.width && snapshot.height >= YR_HD_DIALOG_ART_SIZE.height)
    )
      return screen.name;
  }
  return null;
}

function knownControl(screen: YrHdMenu, control: MenuControlSnapshot): boolean {
  const className = control.className.toLowerCase();
  if (screen !== 'setup' && screen !== 'choose-map') return ['button', 'static'].includes(className);
  if (yrMenuNativeArtControl(screen, control.id)) return className === 'static';
  if (className === 'static')
    return screen === 'setup' ? setupStatics.includes(control.id) : [1684, 65535, 1685].includes(control.id);
  if (className === 'button') {
    if (
      screen === 'setup'
        ? ![1472, 1559, 1450, ...setupChecks].includes(control.id)
        : ![1472, 1733, 1411].includes(control.id)
    )
      return false;
    return (
      !setupChecks.includes(control.id) ||
      (Number.isInteger(control.checked) && control.checked! >= 0 && control.checked! <= 2)
    );
  }
  if (className === 'msctls_trackbar32') {
    const slider = control.slider;
    return (
      !!slider &&
      setupSliders.includes(control.id) &&
      [slider.min, slider.max, slider.value].every(Number.isInteger) &&
      slider.min <= slider.value &&
      slider.value <= slider.max &&
      typeof slider.valueText === 'string' &&
      !!slider.valueText.trim() &&
      !!slider.thumb &&
      inside(slider.thumb, control.rect) &&
      !!slider.groove &&
      inside(slider.groove, control.rect) &&
      slider.groove.x + slider.groove.width + 4 < control.rect.x + control.rect.width
    );
  }
  if (className === 'scrollbar') {
    const scroll = control.scroll;
    return (
      screen === 'choose-map' &&
      control.id === 0 &&
      (control.style & 1) !== 0 &&
      !!scroll &&
      [scroll.min, scroll.max, scroll.page, scroll.pos].every(Number.isInteger) &&
      scroll.min <= scroll.max &&
      scroll.page >= 0 &&
      scroll.pos >= scroll.min &&
      scroll.pos <= Math.max(scroll.min, scroll.max - Math.max(0, scroll.page - 1)) &&
      Number.isInteger(scroll.arrowSize) &&
      scroll.arrowSize! > 0 &&
      !!scroll.groove &&
      inside(scroll.groove, control.rect) &&
      scroll.groove.y >= control.rect.y + scroll.arrowSize! &&
      scroll.groove.y + scroll.groove.height <= control.rect.y + control.rect.height - scroll.arrowSize! &&
      !!scroll.thumb &&
      inside(scroll.thumb, scroll.groove) &&
      scroll.thumb.x === scroll.groove.x &&
      scroll.thumb.width === scroll.groove.width
    );
  }
  if (className === 'listbox' || className === 'combobox') {
    if (className === 'listbox' && !(screen === 'setup' ? control.id === 1696 : [1363, 1771].includes(control.id)))
      return false;
    const { items, selection, topIndex, itemHeight, visibleRows } = control;
    if (
      !control.itemsComplete ||
      !Array.isArray(items) ||
      items.some((item) => typeof item !== 'string') ||
      !Number.isInteger(selection) ||
      selection! < -1 ||
      selection! >= items.length ||
      !Number.isInteger(topIndex) ||
      topIndex! < 0 ||
      topIndex! > Math.max(0, items.length - 1) ||
      !Number.isInteger(itemHeight) ||
      itemHeight! <= 0 ||
      !Number.isInteger(visibleRows) ||
      visibleRows! < 0
    )
      return false;
    if (className === 'combobox' && (!setupCombos.includes(control.id) || !control.popup)) return false;
    if (
      setupColors.includes(control.id) &&
      (!control.itemColors ||
        control.itemColors.length !== items.length ||
        control.itemColors.some((color, index) =>
          color === null ? !items[index]?.trim() : !Number.isInteger(color) || color < 0 || color > 0xffffff,
        ))
    )
      return false;
    return (
      items.every((item, index) => !!item.trim() || control.itemColors?.[index] != null) ||
      (control.id === 1696 && items.length === 0 && !!control.text.trim())
    );
  }
  return false;
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
