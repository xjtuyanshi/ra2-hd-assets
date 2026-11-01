import type { MenuControlSnapshot, MenuSnapshot } from '../../../vm86/menuSnapshot';
import type { VmShell } from '../../../adapter/vmShell';
import {
  identifyYrHdMenu,
  yrMenuText,
  yrMenuNativeArtControl,
  yrMenuCheckControl,
  yrMenuControlId,
  YR_HD_DIALOG_ART_SIZE,
} from '../../../games/yr/hdMenus';
import { devicePixelBox } from './devicePixelBox';
import {
  layoutYrMenuText,
  parseYrMenuFont,
  type YrMenuFont,
  type YrMenuTextGlyph,
} from '../../../games/yr/menuTypography';
import {
  createCanvasGlyphSurface,
  createCoverageGlyphFitter,
  drawFittedGlyph,
  type CoverageGlyphFitter,
  type CoverageGlyphTarget,
} from '../../../graphics/text/coverageGlyphFit';

interface ButtonArt {
  normal: string;
  hover: string;
  pressed: string;
  disabled: string;
}
interface MenuArt {
  version: number;
  strings: string;
  fontMetrics?: string;
  controlSkin?: 'vector-v1';
  main: { shell: string; buttons: ButtonArt };
  themes: Record<string, { background: string; backgroundShade?: number; buttons: ButtonArt }>;
  setup?: { background: string; buttons: ButtonArt };
  chooseMap?: { background: string; buttons: ButtonArt };
  toneRegions?: { file: string; rect: [number, number, number, number]; gain: [number, number, number] }[];
}

type Rect = MenuControlSnapshot['rect'];
// The font is session-owned; cached paths become collectable with that font.
const outlinePaths = new WeakMap<YrMenuFont, Map<string, Path2D>>();
// Ink-weight fits for fonts that supply source ink areas, with the output
// scale (device pixels per game pixel) of the frame being drawn.
const glyphFits = new WeakMap<YrMenuFont, { fitter: CoverageGlyphFitter; scale: number }>();
/** Per-frame fitting budget; unfinished screens stay original and retry next frame. */
const GLYPH_FIT_BUDGET_MS = 8;

function glyphTarget(glyph: YrMenuTextGlyph): CoverageGlyphTarget | null {
  if (glyph.inkArea === undefined || !glyph.ink.width || !glyph.ink.height) return null;
  return {
    text: glyph.text,
    faces: glyph.faces,
    width: glyph.ink.width,
    height: glyph.ink.height,
    ink: glyph.inkArea,
    maxAnisotropy: glyph.maxAnisotropy,
  };
}

/** The original control geometry remains the only input target. */
function drawRecess(ctx: CanvasRenderingContext2D, r: Rect, enabled: boolean, transparent = false): void {
  if (!transparent) {
    ctx.fillStyle = enabled ? '#09101c' : '#14171c';
    ctx.fillRect(r.x, r.y, r.width, r.height);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#839aaf';
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);
  ctx.strokeStyle = '#283543';
  ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.width - 3, r.height - 3);
}

/** Source-shaped bevels are paths at output resolution, never enlarged pixels. */
function drawMenuFrame(ctx: CanvasRenderingContext2D, r: Rect): void {
  ctx.lineWidth = 1;
  // The source bevel is two offset outlines, not three concentric strokes.
  ctx.strokeStyle = '#a5bec5';
  ctx.strokeRect(r.x - 1.5, r.y - 1.5, r.width + 2, r.height + 1);
  ctx.strokeStyle = '#6b7984';
  ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.width + 2, r.height + 1);
}

function drawMenuArrow(ctx: CanvasRenderingContext2D, r: Rect, up: boolean, enabled: boolean): void {
  ctx.save();
  if (up) {
    ctx.translate(0, 2 * r.y + r.height);
    ctx.scale(1, -1);
  }
  const border = ctx.createLinearGradient(r.x, 0, r.x + r.width, 0);
  border.addColorStop(0, '#ce2410');
  border.addColorStop(0.5, '#e67163');
  border.addColorStop(1, '#ce2410');
  ctx.fillStyle = '#620e08';
  ctx.fillRect(r.x, r.y, r.width, r.height);
  ctx.fillStyle = border;
  ctx.fillRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
  const recess = ctx.createLinearGradient(0, r.y + 2, 0, r.y + r.height - 2);
  recess.addColorStop(0, '#951c10');
  recess.addColorStop(0.3, '#6b0808');
  recess.addColorStop(0.55, '#190000');
  recess.addColorStop(1, '#630400');
  ctx.fillStyle = recess;
  ctx.fillRect(r.x + 2, r.y + 2, r.width - 4, r.height - 4);
  const x = r.x + r.width / 2;
  ctx.beginPath();
  ctx.moveTo(r.x + 2, r.y + 6);
  ctx.lineTo(r.x + r.width - 2, r.y + 6);
  ctx.lineTo(x, r.y + r.height - 4);
  ctx.closePath();
  const metal = ctx.createLinearGradient(r.x + 2, 0, r.x + r.width - 2, 0);
  metal.addColorStop(0, '#945d5e');
  metal.addColorStop(0.25, '#cdc0c7');
  metal.addColorStop(0.46, '#eff3ff');
  metal.addColorStop(0.54, '#eff3ff');
  metal.addColorStop(0.75, '#cdc0c7');
  metal.addColorStop(1, '#945d5e');
  ctx.fillStyle = metal;
  ctx.fill();
  const shade = ctx.createLinearGradient(0, r.y + 6, 0, r.y + r.height - 4);
  shade.addColorStop(0, 'rgba(75,0,0,0)');
  shade.addColorStop(1, 'rgba(75,0,0,0.86)');
  ctx.fillStyle = shade;
  ctx.fill();
  if (!enabled) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(r.x, r.y, r.width, r.height);
  }
  ctx.restore();
}

function drawMenuGrip(ctx: CanvasRenderingContext2D, r: Rect, enabled: boolean): void {
  const metal = ctx.createLinearGradient(r.x + 0.5, 0, r.x + r.width - 0.5, 0);
  const stops: [number, string][] = [
    [0, '#661100'],
    [0.06, '#6a5c5d'],
    [0.12, '#020000'],
    [0.3, '#613635'],
    [0.5, '#e8dfdd'],
    [0.7, '#a38a89'],
    [0.88, '#020000'],
    [0.94, '#645758'],
    [1, '#620b00'],
  ];
  for (const [at, color] of stops) metal.addColorStop(at, color);
  ctx.fillStyle = metal;
  ctx.fillRect(r.x, r.y, r.width, r.height);
  if (!enabled) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(r.x, r.y, r.width, r.height);
  }
  ctx.strokeStyle = '#211b19';
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);
}

function drawMenuScroll(ctx: CanvasRenderingContext2D, control: MenuControlSnapshot): void {
  const r = control.rect;
  const { arrowSize, thumb, groove } = control.scroll!;
  drawMenuFrame(ctx, r);
  ctx.fillStyle = '#1b1617';
  ctx.fillRect(groove!.x, groove!.y, groove!.width, groove!.height);
  const arrow = { x: groove!.x, y: r.y + 1, width: Math.min(18, groove!.width), height: arrowSize! };
  drawMenuArrow(ctx, arrow, true, control.enabled);
  drawMenuArrow(ctx, { ...arrow, y: r.y + r.height - arrowSize! - 1 }, false, control.enabled);
  drawMenuGrip(ctx, thumb!, control.enabled);
}

function drawMenuCombo(ctx: CanvasRenderingContext2D, control: MenuControlSnapshot, font?: YrMenuFont): void {
  const r = control.rect;
  drawMenuFrame(ctx, r);
  const arrow = { x: r.x + r.width - 19, y: r.y + 1, width: 18, height: Math.min(22, r.height - 2) };
  drawMenuArrow(ctx, arrow, false, control.enabled);
  const textBox = { ...r, width: r.width - 20 };
  const color = control.itemColors?.[control.selection!];
  if (color != null) {
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.fillRect(r.x + 3, r.y + 4, textBox.width - 5, r.height - 8);
  } else
    drawControlText(
      ctx,
      control.items![control.selection!] ?? control.text,
      textBox,
      control.enabled,
      'left',
      false,
      font,
      false,
      1,
    );
}

function drawMenuName(ctx: CanvasRenderingContext2D, control: MenuControlSnapshot, font: YrMenuFont): void {
  const r = control.rect;
  const edit = control.edit!;
  drawMenuFrame(ctx, r);
  drawControlText(ctx, control.text.slice(edit.firstVisible), r, control.enabled, 'left', false, font, true, 2);
  if (edit.caretVisible && edit.caret >= edit.firstVisible) {
    const advance = layoutYrMenuText(control.text.slice(edit.firstVisible, edit.caret), font)![0]!.width;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    ctx.fillStyle = `#${edit.caretColor.toString(16).padStart(6, '0')}`;
    ctx.fillRect(r.x + 2 + advance, r.y, 2, r.height);
    ctx.restore();
  }
}

function drawControlText(
  ctx: CanvasRenderingContext2D,
  text: string,
  r: Rect,
  enabled: boolean,
  align: CanvasTextAlign = 'left',
  fit = false,
  font?: YrMenuFont,
  topAligned = false,
  leftInset = 3,
): void {
  if (!text) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
  ctx.fillStyle = enabled ? '#ffff00' : '#800000';
  if (font) {
    const lines = layoutYrMenuText(text, font)!;
    const lineTop = topAligned ? r.y : r.y + (r.height - lines.length * font.lineHeight) / 2;
    lines.forEach((line, index) => {
      const inkWidth = Math.max(0, ...line.glyphs.map((glyph) => glyph.x + glyph.ink.x + glyph.ink.width));
      const available = r.width - (align === 'center' ? 6 : leftInset);
      const scale = fit && inkWidth > available ? Math.max(0, available / inkWidth) : 1;
      const left = align === 'center' ? r.x + (r.width - line.width * scale) / 2 : r.x + leftInset;
      for (const glyph of line.glyphs) {
        if (!glyph.ink.width || !glyph.ink.height) continue;
        const target = glyphTarget(glyph);
        const fits = target ? glyphFits.get(font) : undefined;
        const fit = target && fits ? fits.fitter.get(target, fits.scale) : undefined;
        if (fit) {
          drawFittedGlyph(
            ctx,
            fit,
            glyph.text,
            left + (glyph.x + glyph.ink.x) * scale,
            lineTop + index * font.lineHeight + glyph.ink.y,
            scale,
          );
          continue;
        }
        if (glyph.path !== undefined) {
          let paths = outlinePaths.get(font);
          if (!paths) outlinePaths.set(font, (paths = new Map()));
          let path = paths.get(glyph.path);
          if (!path) paths.set(glyph.path, (path = new Path2D(glyph.path)));
          ctx.save();
          ctx.translate(left + (glyph.x + glyph.ink.x) * scale, lineTop + index * font.lineHeight + glyph.ink.y);
          ctx.scale(scale, 1);
          ctx.fill(path, 'evenodd');
          ctx.restore();
          continue;
        }
        ctx.font = glyph.font;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const measured = ctx.measureText(glyph.text);
        const width = measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight;
        const height = measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent;
        if (!width || !height) continue;
        ctx.save();
        ctx.translate(left + (glyph.x + glyph.ink.x) * scale, lineTop + index * font.lineHeight + glyph.ink.y);
        ctx.scale((glyph.ink.width * scale) / width, glyph.ink.height / height);
        ctx.fillText(glyph.text, measured.actualBoundingBoxLeft, measured.actualBoundingBoxAscent);
        ctx.restore();
      }
    });
    ctx.restore();
    return;
  }
  ctx.font = '16px "PingFang SC", "Microsoft YaHei", sans-serif';
  if (fit && ctx.measureText(text).width > r.width - 6) {
    const size = Math.max(8, Math.floor((16 * (r.width - 6)) / ctx.measureText(text).width));
    ctx.font = `${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  }
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, align === 'center' ? r.x + r.width / 2 : r.x + 3, r.y + r.height / 2);
  ctx.restore();
}

function drawList(
  ctx: CanvasRenderingContext2D,
  control: MenuControlSnapshot,
  r: Rect,
  top: number,
  transparent = false,
  font?: YrMenuFont,
  sharp = false,
): void {
  if (sharp) drawMenuFrame(ctx, r);
  else drawRecess(ctx, r, control.enabled, transparent);
  const items = control.items!;
  const height = control.itemHeight!;
  if (items.length === 0) return;
  const visible = Math.max(1, Math.floor((r.height - 2) / height));
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x + 2, r.y + 1, r.width - 4, r.height - 2);
  ctx.clip();
  for (let i = top; i < Math.min(items.length, top + visible + 1); i++) {
    const row = { x: r.x + 2, y: r.y + 1 + (i - top) * height, width: r.width - 4, height };
    if (i === control.selection) {
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(row.x, row.y, row.width, row.height);
    }
    const color = control.itemColors?.[i];
    if (color !== undefined && color !== null) {
      ctx.fillStyle = `#${(color >>> 0).toString(16).padStart(6, '0')}`;
      ctx.fillRect(row.x + 3, row.y + 3, row.width - 6, row.height - 6);
    } else drawControlText(ctx, items[i]!, row, control.enabled, 'left', false, font, false, 1);
  }
  ctx.restore();
}

/** Preserve a complete sourced control until its skin and edit state are represented. */
function retainOriginalControl(ctx: CanvasRenderingContext2D, r: Rect): void {
  // YR paints its outer bevel three pixels outside the logical input rectangle.
  ctx.clearRect(r.x - 3, r.y - 3, r.width + 6, r.height + 6);
}
export interface HdMenus {
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/** Picture-only overlay: all pointer/key input continues to the original canvas and controls. */
export async function startHdMenus(
  host: {
    screen: HTMLCanvasElement;
    vm: VmShell;
    side(): number | null;
    pageCursorAvailable(): boolean;
    battleActive?(): boolean;
    signal?: AbortSignal;
    pointerPosition?(): Readonly<{ x: number; y: number }> | null;
    frameSize(): { width: number; height: number } | null;
    pictureGeneration?(): number | undefined;
    onFramePresented?(listener: () => void): () => void;
  },
  base = '/hd-cache/_ui/menus',
): Promise<HdMenus | null> {
  if (!host.vm.getMenuSnapshot || !host.pageCursorAvailable()) return null;
  const abort = new AbortController();
  const signal = host.signal ? AbortSignal.any([host.signal, abort.signal]) : abort.signal;
  const response = await fetch(`${base}/menus.json`, { signal });
  if (!response.ok) return null;
  const art = (await response.json()) as MenuArt;
  if (art.version !== 1 || !art.main || !art.themes) return null;
  const validFile = (file: string) => /^[a-zA-Z0-9_@.-]+\.(png|json)$/.test(file) && !file.includes('..');
  const names = [
    art.main.shell,
    ...Object.values(art.main.buttons),
    ...Object.values(art.themes).flatMap((theme) => [theme.background, ...Object.values(theme.buttons)]),
    ...[art.setup, art.chooseMap].flatMap((screen) =>
      screen ? [screen.background, ...Object.values(screen.buttons)] : [],
    ),
  ];
  if (
    !validFile(art.strings) ||
    (art.fontMetrics && !validFile(art.fontMetrics)) ||
    names.some((name) => !validFile(name))
  )
    return null;
  if (
    art.toneRegions &&
    (!Array.isArray(art.toneRegions) ||
      art.toneRegions.some(
        (region) =>
          !region ||
          !names.includes(region.file) ||
          !Array.isArray(region.rect) ||
          region.rect.length !== 4 ||
          !Array.isArray(region.gain) ||
          region.gain.length !== 3,
      ))
  )
    return null;
  const images = new Map<string, ImageBitmap>();
  try {
    await Promise.all(
      [...new Set(names)].map(async (name) => {
        const imageResponse = await fetch(`${base}/${name}`, { signal });
        if (!imageResponse.ok) throw new Error(`Menu art unavailable: ${name}`);
        let bitmap = await createImageBitmap(await imageResponse.blob());
        const tones = art.toneRegions?.filter((region) => region.file === name) ?? [];
        if (tones.length) {
          // Calibrate the reviewed artwork once, before it can cover a game
          // picture. Regions refer to asset pixels, not control coordinates.
          const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = surface.getContext('2d');
          if (!context) {
            bitmap.close();
            throw new Error('Menu tone surface unavailable');
          }
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          for (const { rect, gain } of tones) {
            const [x, y, width, height] = rect;
            if (
              !rect.every(Number.isInteger) ||
              x < 0 ||
              y < 0 ||
              width <= 0 ||
              height <= 0 ||
              x + width > surface.width ||
              y + height > surface.height ||
              gain.length !== 3 ||
              !gain.every((value) => Number.isFinite(value) && value > 0 && value <= 4)
            )
              throw new Error('Invalid menu tone calibration');
            const pixels = context.getImageData(x, y, width, height);
            for (let offset = 0; offset < pixels.data.length; offset += 4) {
              for (let channel = 0; channel < 3; channel++)
                pixels.data[offset + channel] = pixels.data[offset + channel]! * gain[channel]!;
            }
            context.putImageData(pixels, x, y);
          }
          bitmap = await createImageBitmap(surface);
        }
        if (signal.aborted) bitmap.close();
        else images.set(name, bitmap);
      }),
    );
    const stringsResponse = await fetch(`${base}/${art.strings}`, { signal });
    if (!stringsResponse.ok) throw new Error('Menu string table unavailable');
    const sourceStrings = (await stringsResponse.json()) as Record<string, string>;
    const strings = Object.fromEntries(Object.entries(sourceStrings).map(([key, value]) => [key.toLowerCase(), value]));
    let font: YrMenuFont | undefined;
    if (art.fontMetrics) {
      const fontResponse = await fetch(`${base}/${art.fontMetrics}`, { signal });
      const parsed = fontResponse.ok ? parseYrMenuFont(await fontResponse.json()) : null;
      if (!parsed) throw new Error('Menu font measurements unavailable');
      font = parsed;
      if (font.inkArea && !font.outlines) {
        const surface = createCanvasGlyphSurface();
        if (!surface) throw new Error('Menu glyph surface unavailable');
        glyphFits.set(font, { fitter: createCoverageGlyphFitter(surface), scale: 0 });
      }
    }
    const canvas = document.createElement('canvas');
    canvas.id = 'hd-menus';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, { position: 'absolute', pointerEvents: 'none', zIndex: '4', display: 'none' });
    host.screen.parentElement!.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      throw new Error('Menu canvas unavailable');
    }
    let snapshot: MenuSnapshot | null = null;
    let disposed = false;
    let enabled = true;
    let timer: number | undefined;
    let request: number | null = null;
    let inputRevision = 0;
    let transitionTree: string | null = null;
    let transitionCandidate: string | null = null;
    let localPointer: { x: number; y: number } | null = null;
    let down = false;
    let pressedControl: number | null = null;
    const hide = (reason: string) => {
      canvas.style.display = 'none';
      canvas.dataset.fallback = reason;
      delete canvas.dataset.screen;
      delete canvas.dataset.generation;
    };
    const render = () => {
      request = null;
      if (disposed || !enabled || !snapshot) {
        hide('inactive');
        return;
      }
      if (!host.pageCursorAvailable()) {
        hide('cursor-unavailable');
        return;
      }
      const size = host.frameSize();
      if (!size || size.width !== snapshot.width || size.height !== snapshot.height) {
        hide('picture-size');
        return;
      }
      if (!snapshot.generation || snapshot.generation !== host.pictureGeneration?.()) {
        hide('picture-generation');
        return;
      }
      const screen = identifyYrHdMenu(snapshot);
      if (!screen) {
        hide('unknown-dialog');
        return;
      }
      const controls = snapshot.controls.filter((control) => control.visible && control.hwnd !== snapshot!.dialogHwnd);
      if (
        art.controlSkin === 'vector-v1' &&
        controls.some(
          (control) =>
            control.className.toLowerCase() === 'combobox' && (control.rect.width <= 20 || control.rect.height < 23),
        )
      ) {
        // The web control is 23 pixels high; the native control is 25. The
        // arrow fits either with a one-pixel inset and a 20-pixel text reserve.
        // Keep smaller, unobserved geometries whole.
        hide('control-geometry');
        return;
      }
      const texts = controls.map((control) => {
        if (control.popupOwner !== undefined) return '';
        if (yrMenuNativeArtControl(screen, control.id)) return '';
        const className = control.className.toLowerCase();
        // Editable values and selected items are literal game strings, never
        // accelerator-bearing captions or CSF resource keys.
        if (screen === 'setup' && control.id === 1696) return control.text;
        if (className === 'combobox' && art.controlSkin === 'vector-v1')
          return control.itemColors?.[control.selection!] != null
            ? ''
            : (control.items?.[control.selection!] ?? control.text);
        if (['combobox', 'scrollbar', 'msctls_trackbar32'].includes(className)) return '';
        if (className === 'listbox') {
          return control.text ? yrMenuText(control, strings) : '';
        }
        return yrMenuText(control, strings);
      });
      if (texts.some((text) => text === null)) {
        hide('unknown-text');
        return;
      }
      const fontLayouts = font
        ? [
            ...texts,
            ...controls.flatMap((control) => [
              ...(control.items ?? []),
              ...(control.slider?.valueText ? [control.slider.valueText] : []),
            ]),
          ].map((text) => (text === null ? [] : layoutYrMenuText(text, font!)))
        : [];
      if (fontLayouts.some((lines) => lines === null)) {
        hide('unknown-font-glyph');
        return;
      }
      const pregame = screen === 'setup' || screen === 'choose-map';
      const screenArt = screen === 'setup' ? art.setup : screen === 'choose-map' ? art.chooseMap : null;
      if (pregame && !screenArt) {
        hide('screen-art-unavailable');
        return;
      }
      const theme = art.themes[String(host.side())];
      if (screen !== 'main' && !pregame && !theme) {
        hide('unknown-theme');
        return;
      }
      const buttons = screenArt?.buttons ?? (screen === 'main' ? art.main.buttons : theme.buttons);
      const box = devicePixelBox(host.screen, size, window.devicePixelRatio || 1);
      Object.assign(canvas.style, box.style);
      if (canvas.width !== box.width) canvas.width = box.width;
      if (canvas.height !== box.height) canvas.height = box.height;
      const fits = font ? glyphFits.get(font) : undefined;
      if (fits) {
        // Fit every glyph the screen can show, including unscrolled list rows,
        // before covering the original; a partial screen stays original.
        fits.scale = Math.sqrt((canvas.width / size.width) * (canvas.height / size.height));
        const targets = fontLayouts.flatMap((lines) =>
          lines!.flatMap((line) => line.glyphs.flatMap((glyph) => glyphTarget(glyph) ?? [])),
        );
        if (!fits.fitter.prepare(targets, fits.scale, GLYPH_FIT_BUDGET_MS)) {
          hide('font-fitting');
          schedule();
          return;
        }
        // A source glyph the host faces cannot draw (a C1 control code, say)
        // would silently vanish; keep the complete original screen instead.
        if (targets.some((target) => !fits.fitter.get(target, fits.scale))) {
          hide('unknown-font-glyph');
          return;
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.scale(canvas.width / size.width, canvas.height / size.height);
      if (screenArt) ctx.drawImage(images.get(screenArt.background)!, 0, 0, 800, 600);
      else if (screen === 'main') ctx.drawImage(images.get(art.main.shell)!, 0, 0, 800, 600);
      else {
        ctx.drawImage(images.get(theme.background)!, 0, 0, YR_HD_DIALOG_ART_SIZE.width, YR_HD_DIALOG_ART_SIZE.height);
        const shade = theme.backgroundShade;
        if (typeof shade === 'number' && Number.isFinite(shade) && shade >= 0 && shade <= 1) {
          ctx.fillStyle = `rgba(0,0,0,${shade})`;
          ctx.fillRect(8, 8, 840, 720);
        }
      }
      const pointer =
        (document.pointerLockElement === host.screen ? host.pointerPosition?.() : null) ??
        localPointer ??
        snapshot.pointer;
      controls.forEach((control, index) => {
        const text = texts[index]!;
        const r = control.rect;
        const className = control.className.toLowerCase();
        let pressedCaptionHidden = false;
        if (control.popupOwner !== undefined) return;
        if (screen === 'setup' && control.id === 1696) {
          // Only the verified caret-only editor is represented. Composition
          // or unknown edit state retains the whole original control.
          if (art.controlSkin === 'vector-v1' && font && control.edit) drawMenuName(ctx, control, font);
          else retainOriginalControl(ctx, r);
          return;
        }
        if (yrMenuNativeArtControl(screen, control.id)) {
          // Keep each original preview, flag and live gauge as a complete image.
          ctx.clearRect(r.x, r.y, r.width, r.height);
          return;
        }
        if (pregame && ['scrollbar', 'combobox', 'msctls_trackbar32'].includes(className)) {
          // Keep the entire slider original until its value plate is calibrated.
          if (art.controlSkin !== 'vector-v1' || className === 'msctls_trackbar32') retainOriginalControl(ctx, r);
          else if (className === 'combobox') drawMenuCombo(ctx, control, font);
          else if (className === 'scrollbar') drawMenuScroll(ctx, control);
          return;
        }
        if (pregame && className === 'listbox') {
          drawList(ctx, control, r, control.topIndex!, true, font, art.controlSkin === 'vector-v1');
          return;
        }
        if (yrMenuCheckControl(screen, control.id)) {
          const box = { x: r.x, y: r.y, width: 17, height: 17 };
          if (art.controlSkin === 'vector-v1') {
            ctx.fillStyle = '#430000';
            ctx.fillRect(r.x, r.y, 18, 18);
            ctx.strokeStyle = '#a0adb4';
            ctx.lineWidth = 1;
            ctx.strokeRect(r.x + 0.5, r.y + 0.5, 17, 17);
          } else drawRecess(ctx, box, control.enabled);
          const gradient = ctx.createRadialGradient(r.x + 8, r.y + 7, 0, r.x + 8.5, r.y + 8.5, 7);
          if (art.controlSkin === 'vector-v1') {
            gradient.addColorStop(0, control.checked === 1 ? '#ffbf00' : '#e5edf0');
            gradient.addColorStop(0.5, control.checked === 1 ? '#ff9000' : '#b2bdc2');
            gradient.addColorStop(1, control.checked === 1 ? '#d83a00' : '#263139');
          } else {
            gradient.addColorStop(0, control.checked === 1 ? '#fff225' : '#d8e3e7');
            gradient.addColorStop(1, control.checked === 1 ? '#ed3d00' : '#35475b');
          }
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(r.x + 8.5, r.y + 8.5, 6.5, 0, 2 * Math.PI);
          ctx.fill();
          drawControlText(
            ctx,
            text,
            { x: r.x + 22, y: r.y, width: r.width - 22, height: r.height },
            control.enabled,
            'left',
            false,
            font,
          );
          return;
        }
        if (className === 'button') {
          if (!control.enabled) {
            retainOriginalControl(ctx, r);
            return;
          }
          const hover = pointer.x >= r.x && pointer.y >= r.y && pointer.x < r.x + r.width && pointer.y < r.y + r.height;
          const state = !control.enabled
            ? 'disabled'
            : control.pressed || (hover && down && pressedControl === control.hwnd)
              ? 'pressed'
              : hover
                ? 'hover'
                : 'normal';
          // The frontend repaints the pressed plate over its caption until release.
          pressedCaptionHidden = state === 'pressed' && (pregame || screen === 'main');
          ctx.save();
          // Optional art may share a plate between states. Preserve the real
          // control state visibly without inventing a new interaction target.
          if (state === 'disabled' && buttons.disabled === buttons.normal) ctx.filter = 'brightness(0.55)';
          else if (buttons[state] === buttons.normal && state === 'hover') ctx.filter = 'brightness(1.22)';
          ctx.drawImage(images.get(buttons[state])!, r.x, r.y, r.width, r.height);
          if (state === 'pressed' && buttons[state] === buttons.normal) {
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = 'rgba(255,175,0,0.65)';
            ctx.fillRect(r.x + 12, r.y + 10, r.width - 31, r.height - 21);
          }
          ctx.restore();
          if (control.focused && !pregame && screen !== 'main') {
            ctx.strokeStyle = '#f1d970';
            ctx.lineWidth = 0.6;
            ctx.strokeRect(r.x + 4, r.y + 4, r.width - 8, r.height - 8);
          }
        } else if (text && screen !== 'main' && !pregame && yrMenuControlId(control) !== 65535) {
          // The redrawn background already clears the prompt. Only labels over
          // retained chrome need a backing, inset so metal borders remain intact.
          ctx.fillStyle = '#030404';
          ctx.fillRect(r.x + 10, r.y + 2, r.width - 20, r.height - 4);
        }
        if (!text || pressedCaptionHidden) return;
        if (font) {
          drawControlText(
            ctx,
            text,
            r,
            control.enabled,
            pregame && className === 'static' && (control.style & 0x1f) === 0 ? 'left' : 'center',
            true,
            font,
            (screen === 'quit' && yrMenuControlId(control) === 65535) || (screen === 'setup' && control.id === 1448),
            0,
          );
          return;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.width, r.height);
        ctx.clip();
        ctx.fillStyle = control.enabled ? '#ffff00' : '#800000';
        ctx.textAlign = pregame && className === 'static' && (control.style & 0x1f) === 0 ? 'left' : 'center';
        ctx.textBaseline = 'middle';
        let fontSize = 16;
        ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        const measured = ctx.measureText(text).width;
        if (measured > r.width - 8) {
          fontSize *= (r.width - 8) / measured;
          ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        }
        // The game's quit prompt starts at the top of its static rectangle;
        // button captions remain vertically centered in their original plates.
        const prompt = screen === 'quit' && yrMenuControlId(control) === 65535;
        if (prompt) ctx.textBaseline = 'alphabetic';
        const y = prompt ? r.y + ctx.measureText(text).actualBoundingBoxAscent : r.y + r.height / 2;
        ctx.fillText(text, ctx.textAlign === 'left' ? r.x : r.x + r.width / 2, y + (control.pressed ? 1 : 0));
        ctx.restore();
      });
      // Popup painting is last, exactly as the game's z-ordered child window.
      for (const control of controls) {
        if (control.popup?.dropped) {
          const scrollbar = controls.find((candidate) => candidate.hwnd === control.popup!.scrollbarHwnd);
          const rect = control.popup.rect;
          // The game restores its clean background behind the popup. Restore
          // that same region so underlying player text cannot show through.
          if (screenArt) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(rect.x, rect.y, rect.width + (scrollbar?.rect.width ?? 0), rect.height);
            ctx.clip();
            ctx.drawImage(images.get(screenArt.background)!, 0, 0, 800, 600);
            ctx.restore();
          }
          drawList(
            ctx,
            { ...control, selection: control.popup.selection },
            rect,
            control.popup.topIndex,
            !!screenArt,
            font,
            art.controlSkin === 'vector-v1',
          );
          if (scrollbar) {
            if (
              art.controlSkin === 'vector-v1' &&
              scrollbar.scroll?.thumb &&
              scrollbar.scroll.groove &&
              scrollbar.scroll.arrowSize
            )
              drawMenuScroll(ctx, scrollbar);
            else retainOriginalControl(ctx, scrollbar.rect);
          }
        }
      }
      canvas.style.display = 'block';
      canvas.dataset.screen = screen;
      canvas.dataset.generation = String(snapshot.generation);
      delete canvas.dataset.fallback;
    };
    const schedule = () => {
      if (!disposed && request === null) request = requestAnimationFrame(render);
    };
    // The native picture can change without input or a dialog-root change.
    // Invalidate before the browser paints that picture, not at the next poll.
    const unsubscribeFrame = host.onFramePresented?.(() => {
      if (!snapshot || snapshot.generation !== host.pictureGeneration?.()) hide('picture-generation');
      schedule();
    });
    const dialogTree = (value: MenuSnapshot) =>
      JSON.stringify([
        value.dialogHwnd,
        value.width,
        value.height,
        value.controls.map(({ hwnd, parent, id, className, style, text, textComplete, rect, visible, enabled }) => [
          hwnd,
          parent,
          id,
          className,
          style,
          text,
          textComplete,
          rect,
          visible,
          enabled,
        ]),
      ]);
    const poll = async () => {
      const revision = inputRevision;
      try {
        const next = enabled && !host.battleActive?.() ? await host.vm.getMenuSnapshot!() : null;
        if (!disposed && revision === inputRevision) {
          // A bounded native state query can time out while pointer input is
          // flowing through an unchanged dialog. Keep its verified picture,
          // but never retain it over a changed tree, null or an activation.
          const verifiedNext =
            transitionTree === null &&
            snapshot?.complete &&
            next &&
            !next.complete &&
            dialogTree(next) === dialogTree(snapshot)
              ? snapshot
              : next;
          const tree = verifiedNext?.complete ? dialogTree(verifiedNext) : null;
          // The native ACK precedes a handler's posted/animated dialog swap.
          // A new tree is usable immediately; an unchanged no-op dialog needs
          // two fresh observations before its HD picture is restored.
          if (transitionTree !== null && (!tree || (tree === transitionTree && tree !== transitionCandidate))) {
            transitionCandidate = tree;
            snapshot = null;
          } else {
            transitionTree = null;
            transitionCandidate = null;
            snapshot = verifiedNext;
          }
          schedule();
        }
      } catch {
        if (!disposed && revision === inputRevision) {
          snapshot = null;
          transitionCandidate = null;
          hide('snapshot-unavailable');
        }
      }
      if (!disposed) timer = window.setTimeout(poll, snapshot || transitionTree !== null ? 80 : 250);
    };
    const pointer = (event: PointerEvent) => {
      if (!snapshot) return;
      if (document.pointerLockElement !== host.screen) {
        const box = host.screen.getBoundingClientRect();
        localPointer = {
          x: ((event.clientX - box.left) * snapshot.width) / box.width,
          y: ((event.clientY - box.top) * snapshot.height) / box.height,
        };
      }
      down = (event.buttons & 1) !== 0;
      if (event.type === 'pointerdown' && event.button === 0) {
        const position =
          (document.pointerLockElement === host.screen ? host.pointerPosition?.() : null) ?? localPointer;
        pressedControl = position
          ? (snapshot.controls.find(
              (control) =>
                control.className === 'Button' &&
                control.visible &&
                control.enabled &&
                position.x >= control.rect.x &&
                position.y >= control.rect.y &&
                position.x < control.rect.x + control.rect.width &&
                position.y < control.rect.y + control.rect.height,
            )?.hwnd ?? null)
          : null;
      }
      schedule();
    };
    const invalidate = (event: Event) => {
      let activates = false;
      if (event instanceof PointerEvent) {
        // A release outside the pressed control cancels the original click.
        // Read the release position too: there need not have been a move event.
        pointer(event);
        const position =
          (document.pointerLockElement === host.screen ? host.pointerPosition?.() : null) ?? localPointer;
        const control = snapshot?.controls.find((control) => control.hwnd === pressedControl);
        activates =
          event.button === 0 &&
          !!position &&
          !!control?.visible &&
          control.enabled &&
          position.x >= control.rect.x &&
          position.y >= control.rect.y &&
          position.x < control.rect.x + control.rect.width &&
          position.y < control.rect.y + control.rect.height;
        down = false;
        pressedControl = null;
      } else if (event instanceof KeyboardEvent) {
        // Games can implement Escape through a custom return button ID.
        activates =
          !!snapshot &&
          (event.key === 'Escape' ||
            (['Enter', ' '].includes(event.key) &&
              snapshot.controls.some(
                (control) =>
                  control.className === 'Button' &&
                  control.visible &&
                  control.enabled &&
                  (control.focused || (event.key === 'Enter' && ((control.style & 0xf) === 1 || control.id === 1))),
              )));
      }
      if (!activates) {
        schedule();
        return;
      }
      inputRevision++;
      transitionTree = snapshot ? dialogTree(snapshot) : transitionTree;
      transitionCandidate = null;
      snapshot = null;
      hide('input-transition');
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(host.screen);
    host.screen.addEventListener('pointermove', pointer);
    host.screen.addEventListener('pointerdown', pointer);
    host.screen.addEventListener('pointerup', invalidate);
    window.addEventListener('keydown', invalidate);
    void poll();
    return {
      setEnabled(next) {
        enabled = next;
        schedule();
      },
      dispose() {
        disposed = true;
        unsubscribeFrame?.();
        abort.abort();
        clearTimeout(timer);
        if (request !== null) cancelAnimationFrame(request);
        resize.disconnect();
        host.screen.removeEventListener('pointermove', pointer);
        host.screen.removeEventListener('pointerdown', pointer);
        host.screen.removeEventListener('pointerup', invalidate);
        window.removeEventListener('keydown', invalidate);
        canvas.remove();
        images.forEach((image) => image.close());
      },
    };
  } catch (error) {
    abort.abort();
    images.forEach((image) => image.close());
    throw error;
  }
}
