import type { UiAssets } from './uiAssets';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Structural input only: the renderer package never imports the application's game contracts. */
export interface Sidebar {
  frame: { width: number; height: number };
  side: number;
  layout: {
    sidebar: Rect;
    commandBar: Rect | null;
    radar: Rect;
    credits: Rect;
    strip: Rect;
    creditsAnchor: { x: number; y: number };
    cameo: { width: number; height: number };
    cameoPitch: { x: number; y: number };
    cameoOrigin: { x: number; y: number };
    tabs: Rect[];
    buttons: { repair: Rect | null; sell: Rect | null };
    power: { x: number; y: number; width: number; slotHeight: number; slots: number };
  };
  activeTab: number;
  tabs: { count: number; flashing: boolean }[];
  cameos: Cameo[];
  credits: number;
  power: { used: number; reserve: number; surplus: number; low: boolean };
  radarActive: boolean;
  modes: { repair: boolean; sell: boolean };
  labels: { ready: string | null; hold: string | null };
  pointer?: { x: number; y: number; frame: number; hotspot: { x: number; y: number } } | null;
  tooltip?: { rect: Rect; text: string } | null;
}
export interface Cameo {
  x: number;
  y: number;
  id: string;
  image: string | null;
  name: string;
  cost: number | null;
  progress: number | null;
  ready: boolean;
  hold: boolean;
  darkened: boolean;
  queued: number;
  flashing: boolean;
  hovered: boolean;
}

export const UI_FONT =
  '"PingFang TC","PingFang SC","Hiragino Sans","Microsoft JhengHei","Noto Sans CJK TC","Segoe UI",system-ui,sans-serif';
export const NUM_FONT = '"DIN Alternate","Bahnschrift","Roboto Condensed","Arial Narrow",' + UI_FONT;
const ACCENTS = ['#4a9dff', '#e0402f', '#b45cff'];
const accentOf = (side: number) => ACCENTS[side] ?? '#9aa4b2';
const valid = (r: Rect) => r.width > 0 && r.height > 0;

function without(rect: Rect, hole: Rect): Rect[] {
  const left = Math.max(rect.x, hole.x);
  const right = Math.min(rect.x + rect.width, hole.x + hole.width);
  const top = Math.max(rect.y, hole.y);
  const bottom = Math.min(rect.y + rect.height, hole.y + hole.height);
  if (right <= left || bottom <= top) return [rect];
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: top - rect.y },
    { x: rect.x, y: bottom, width: rect.width, height: rect.y + rect.height - bottom },
    { x: rect.x, y: top, width: left - rect.x, height: bottom - top },
    { x: right, y: top, width: rect.x + rect.width - right, height: bottom - top },
  ].filter(valid);
}

export function transparentRects(sidebar: Sidebar, assets: UiAssets): Rect[] {
  const l = sidebar.layout;
  const tooltip = sidebar.tooltip ? [sidebar.tooltip.rect] : [];
  if (assets.chrome(sidebar.side)) {
    return [
      ...(sidebar.radarActive ? without(l.sidebar, l.radar) : [l.sidebar]),
      ...(l.commandBar ? [l.commandBar] : []),
      ...tooltip,
    ].filter(valid);
  }
  return [l.strip, { ...l.power, height: l.power.slotHeight * l.power.slots }, l.credits, ...l.tabs, ...tooltip]
    .filter(valid)
    .map(({ x, y, width, height }) => ({ x, y, width, height }));
}

/** All geometry is in frame pixels; the caller provides device pixels per frame pixel. */
export function drawSidebar(
  ctx: CanvasRenderingContext2D,
  sidebar: Sidebar,
  assets: UiAssets,
  opts: { scale: number; time: number; pointerPosition?: Readonly<{ x: number; y: number }> | null },
): void {
  if (!(opts.scale > 0)) return;
  const { layout: l } = sidebar;
  const accent = accentOf(sidebar.side);
  const rgb = accent
    .slice(1)
    .match(/../g)!
    .map((hex) => parseInt(hex, 16));
  const snap = (v: number) => Math.round(v * opts.scale) / opts.scale;
  const rect = (r: Rect): Rect => ({
    x: snap(r.x),
    y: snap(r.y),
    width: snap(r.x + r.width) - snap(r.x),
    height: snap(r.y + r.height) - snap(r.y),
  });
  const fill = (r: Rect, color: string | CanvasGradient) => {
    const p = rect(r);
    ctx.fillStyle = color;
    ctx.fillRect(p.x, p.y, p.width, p.height);
  };
  const rounded = (r: Rect, radius = 2) => {
    const p = rect(r);
    ctx.beginPath();
    ctx.roundRect(p.x, p.y, p.width, p.height, radius);
  };
  const gradient = (r: Rect, top: string, bottom: string) => {
    const value = ctx.createLinearGradient(0, r.y, 0, r.y + r.height);
    value.addColorStop(0, top);
    value.addColorStop(1, bottom);
    return value;
  };
  const pulse = (hz: number, min: number, max: number) =>
    min + (max - min) * (0.5 + 0.5 * Math.sin((opts.time / 1000) * Math.PI * 2 * hz));
  const outline = (r: Rect, color: string, width: number) => {
    rounded({ x: r.x + width / 2, y: r.y + width / 2, width: r.width - width, height: r.height - width });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const font = (weight: number, size: number, numeric = false) => {
    ctx.font = `${weight} ${size}px ${numeric ? NUM_FONT : UI_FONT}`;
  };
  const text = (value: string, x: number, y: number, color: string | CanvasGradient) => {
    ctx.fillStyle = color;
    ctx.fillText(value, snap(x), snap(y));
  };
  const outlinedText = (value: string, x: number, y: number, color: string | CanvasGradient) => {
    ctx.strokeStyle = '#090b10';
    // A centred 2px stroke leaves a 1-frame-pixel dark outline outside the fill.
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.strokeText(value, snap(x), snap(y));
    text(value, x, y, color);
  };
  const statusCaption = (value: string, r: Rect, left: boolean) => {
    ctx.save();
    let size = 13;
    font(700, size);
    const available = r.width - 6;
    while (ctx.measureText(value).width > available && size > 10) {
      size -= 0.25;
      font(700, size);
    }
    const width = Math.min(available, ctx.measureText(value).width) + 6;
    const x = left ? r.x + 3 : r.x + (r.width - width) / 2;
    const centerY = r.y + 20;
    rounded({ x, y: centerY - (size + 6) / 2, width, height: size + 6 });
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fill();
    ctx.globalAlpha = pulse(1.2, 0.85, 1);
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#090b10';
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    // At the minimum font size, constrain unusually long translations to the same text box.
    ctx.strokeText(value, snap(x + width / 2), snap(centerY), available);
    ctx.fillStyle = '#ffd84a';
    ctx.fillText(value, snap(x + width / 2), snap(centerY), available);
    ctx.restore();
  };
  ctx.save();
  ctx.scale(opts.scale, opts.scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const chrome = assets.chrome(sidebar.side);
  if (chrome) {
    ctx.save();
    ctx.beginPath();
    for (const r of transparentRects(sidebar, assets)) {
      const p = rect(r);
      ctx.rect(p.x, p.y, p.width, p.height);
    }
    ctx.clip();
    fill(l.sidebar, '#101216');
    if (l.commandBar) fill(l.commandBar, '#101216');
    for (const piece of chrome.pieces) {
      const anchor = piece.anchor === 'sidebar' ? l.sidebar : l.commandBar;
      if (!anchor) continue;
      const target = { ...piece.rect, x: anchor.x + piece.rect.x, y: anchor.y + piece.rect.y };
      const p = rect(target);
      ctx.drawImage(piece.bitmap, p.x, p.y, p.width, p.height);
    }
    // Soviet metal trim is subdued so faction artwork remains dominant.
    if (sidebar.side === 1) fill({ x: l.sidebar.x, y: l.sidebar.y, width: l.sidebar.width, height: 1 }, '#d4a548');
    ctx.restore();
  } else {
    fill(l.strip, '#0d0f13');
    ctx.save();
    ctx.beginPath();
    ctx.rect(l.strip.x, l.strip.y, l.strip.width, l.strip.height);
    ctx.clip();
    if (l.cameoPitch.x > 0 && l.cameoPitch.y > 0) {
      for (let y = l.cameoOrigin.y; y + l.cameo.height <= l.strip.y + l.strip.height; y += l.cameoPitch.y) {
        for (let x = l.cameoOrigin.x; x + l.cameo.width <= l.strip.x + l.strip.width; x += l.cameoPitch.x) {
          const r = { x, y, ...l.cameo };
          rounded(r);
          ctx.fillStyle = '#101216';
          ctx.fill();
          ctx.save();
          rounded(r);
          ctx.clip();
          fill(
            { x, y, width: r.width, height: 3 },
            gradient({ x, y, width: r.width, height: 3 }, 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0)'),
          );
          outline({ x: x + 1, y: y + 1, width: r.width - 2, height: r.height - 2 }, 'rgba(255,255,255,0.06)', 1);
          ctx.restore();
        }
      }
    }
    ctx.restore();
    fill(l.credits, gradient(l.credits, '#1a1c21', '#0d0e11'));
    ctx.save();
    ctx.globalAlpha = 0.6;
    fill({ x: l.credits.x, y: l.credits.y + l.credits.height - 1, width: l.credits.width, height: 1 }, accent);
    ctx.restore();
    l.tabs.forEach((r, i) => {
      rounded(r);
      ctx.fillStyle = '#1b1e24';
      ctx.fill();
      outline(r, 'rgba(255,255,255,0.10)', 1);
      ctx.save();
      ctx.translate(r.x + r.width / 2, r.y + r.height / 2);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#d8dde6';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (i === 0) {
        ctx.moveTo(-7, -1);
        ctx.lineTo(0, -7);
        ctx.lineTo(7, -1);
        ctx.moveTo(-5, -2);
        ctx.lineTo(-5, 6);
        ctx.lineTo(5, 6);
        ctx.lineTo(5, -2);
        ctx.moveTo(-1, 6);
        ctx.lineTo(-1, 1);
        ctx.lineTo(2, 1);
        ctx.lineTo(2, 6);
      } else if (i === 1) {
        ctx.moveTo(-6, -6);
        ctx.lineTo(6, -6);
        ctx.lineTo(5, 2);
        ctx.lineTo(0, 7);
        ctx.lineTo(-5, 2);
        ctx.closePath();
      } else if (i === 2) {
        ctx.arc(0, -4, 2.5, 0, Math.PI * 2);
        ctx.moveTo(-5, 6);
        ctx.lineTo(-4, 1);
        ctx.lineTo(4, 1);
        ctx.lineTo(5, 6);
      } else {
        ctx.rect(-7, 1, 14, 5);
        ctx.rect(-3, -3, 7, 4);
        ctx.moveTo(3, -2);
        ctx.lineTo(9, -2);
      }
      ctx.stroke();
      ctx.restore();
    });
  }

  ctx.save();
  ctx.beginPath();
  const strip = rect(l.strip);
  ctx.rect(strip.x, strip.y, strip.width, strip.height);
  ctx.clip();
  for (const c of sidebar.cameos) {
    const r = rect({ x: c.x, y: c.y, ...l.cameo });
    ctx.save();
    rounded(r, 2);
    ctx.clip();
    const image = assets.cameo(c.id, c.image);
    if (image) {
      const ratio = Math.max(r.width / image.width, r.height / image.height);
      const sw = r.width / ratio;
      const sh = r.height / ratio;
      ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, r.x, r.y, r.width, r.height);
    } else {
      fill(r, '#15181d');
      font(600, 8.5);
      text(c.name, r.x + r.width / 2, r.y + r.height / 2, '#9aa4b2');
    }
    const caption = { x: r.x, y: r.y + r.height - 12, width: r.width, height: 12 };
    fill(caption, gradient(caption, 'rgba(0,0,0,0)', 'rgba(0,0,0,0.80)'));
    let size = 8.5;
    font(700, size);
    while (ctx.measureText(c.name).width > r.width - 4 && size > 6.5) {
      size -= 0.25;
      font(700, size);
    }
    let name = c.name;
    if (ctx.measureText(name).width > r.width - 4) {
      while (name.length && ctx.measureText(name + '…').width > r.width - 4) name = name.slice(0, -1);
      name += '…';
    }
    outlinedText(name, r.x + r.width / 2, r.y + r.height - 2.5, '#f4f1e8');
    if (c.darkened) fill(r, 'rgba(8,10,14,0.62)');
    if (c.progress !== null) {
      const progress = Math.max(0, Math.min(1, c.progress));
      const angle = -Math.PI / 2 + progress * Math.PI * 2;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const radius = Math.hypot(r.width, r.height) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.width, r.height);
      ctx.clip();
      if (progress < 1) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, angle, Math.PI * 1.5);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,0,0,0.58)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    if (c.ready) {
      statusCaption(sidebar.labels.ready ?? 'Ready', r, false);
      outline(r, accent, 1.5);
    }
    if (c.hold) {
      statusCaption(sidebar.labels.hold ?? 'On Hold', r, c.queued > 0);
    }
    if (c.queued > 0) {
      font(700, 8.5, true);
      const label = String(c.queued);
      const width = Math.max(11, ctx.measureText(label).width + 4);
      const badge = { x: r.x + 60 - 2 - width, y: r.y + 2, width, height: 11 };
      rounded(badge);
      ctx.fillStyle = 'rgba(10,12,16,0.85)';
      ctx.fill();
      outline(badge, accent, 1);
      text(label, badge.x + width / 2, badge.y + 8.5, '#fff');
    }
    if (c.flashing && Math.floor(opts.time / 125) % 2 === 0) fill(r, 'rgba(255,255,255,0.45)');
    if (c.hovered) {
      const light = rgb.map((channel) => Math.round(channel * 0.65 + 255 * 0.35));
      outline(r, `rgb(${light.join(',')})`, 1.5);
      fill(r, 'rgba(255,255,255,0.08)');
    }
    outline(r, 'rgba(0,0,0,0.70)', 0.75);
    fill({ x: r.x + 2, y: r.y + 1, width: r.width - 4, height: 0.75 }, 'rgba(255,255,255,0.15)');
    ctx.restore();
  }
  ctx.restore();

  l.tabs.forEach((r, i) => {
    const tab = sidebar.tabs[i];
    if (!tab) return;
    if (chrome?.tabs) {
      if (tab.count <= 0) return;
      const state = tab.flashing
        ? Math.floor(opts.time / 500) % 2 === 0
          ? 'active'
          : 'normal'
        : sidebar.activeTab === i
          ? 'active'
          : 'normal';
      const frame = chrome.tabs.frames.find((frame) => frame.tab === i && frame.state === state);
      if (frame) {
        const source = frame.rect,
          target = rect(r);
        ctx.drawImage(
          chrome.tabs.bitmap,
          source.x,
          source.y,
          source.width,
          source.height,
          target.x,
          target.y,
          target.width,
          target.height,
        );
      }
      return;
    }
    if (!tab.count) fill(r, 'rgba(0,0,0,0.6)');
    if (tab.flashing) {
      ctx.save();
      ctx.globalAlpha = pulse(2, 0.15, 0.45);
      fill(r, accent);
      ctx.restore();
    }
    if (sidebar.activeTab === i) {
      ctx.save();
      ctx.shadowColor = accent;
      ctx.shadowBlur = 4 * opts.scale;
      const glow = { x: r.x + 2, y: r.y + 1, width: r.width - 4, height: 6 };
      fill(glow, gradient(glow, `rgba(${rgb.join(',')},0.25)`, `rgba(${rgb.join(',')},0)`));
      outline({ x: r.x + 1, y: r.y + 1, width: r.width - 2, height: r.height - 2 }, accent, 1.5);
      ctx.restore();
    }
  });
  for (const mode of ['repair', 'sell'] as const) {
    const r = l.buttons[mode];
    if (sidebar.modes[mode] && r) {
      ctx.save();
      ctx.shadowBlur = 6 * opts.scale;
      ctx.shadowColor = accent;
      outline(r, accent, 1.5);
      ctx.restore();
    }
  }

  const power = { ...l.power, height: l.power.slots * l.power.slotHeight };
  fill(power, '#0b0c0f');
  outline(power, 'rgba(255,255,255,0.08)', 1);
  let bottom = power.y + power.height;
  let remaining = power.slots;
  const bands = [
    [sidebar.power.used, '#ff7468', '#e5483a'],
    [sidebar.power.reserve, '#ffe077', '#f2c53d'],
    [sidebar.power.surplus, '#7deb9d', '#3fd46a'],
  ] as const;
  bands.forEach(([slots, top, color], i) => {
    const count = Math.min(remaining, Math.max(0, slots));
    remaining -= count;
    const height = count * power.slotHeight;
    bottom -= height;
    if (!height) return;
    const band = { x: power.x + 1, y: bottom, width: power.width - 2, height };
    ctx.save();
    if (i === 0 && sidebar.power.low) ctx.globalAlpha = pulse(2, 0.6, 1);
    fill(band, gradient(band, top, color));
    ctx.restore();
  });
  for (let i = 1; i < power.slots; i++)
    fill({ x: power.x, y: power.y + i * power.slotHeight, width: power.width, height: 1 }, 'rgba(0,0,0,0.75)');
  fill(
    { x: power.x + power.width / 3, y: power.y + 1, width: 1, height: Math.max(0, power.height - 2) },
    'rgba(255,255,255,0.25)',
  );

  ctx.save();
  font(700, 12, true);
  ctx.textBaseline = 'top';
  const credits = { x: l.creditsAnchor.x, y: l.creditsAnchor.y, width: 0, height: 12 };
  outlinedText(String(sidebar.credits), credits.x, credits.y, gradient(credits, '#fff3a0', '#f1c232'));
  ctx.restore();

  if (sidebar.tooltip) {
    const panel = rect(sidebar.tooltip.rect);
    ctx.save();
    ctx.beginPath();
    ctx.rect(panel.x, panel.y, panel.width, panel.height);
    ctx.clip();
    fill(panel, '#0c0e12');
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(panel.x + 0.5, panel.y + 0.5, panel.width - 1, panel.height - 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const lines = sidebar.tooltip.text.split(/\r\n|\r|\n/);
    const lineHeight = Math.min(13, (panel.height - 4) / lines.length);
    font(700, Math.max(1, Math.min(11, lineHeight - 1)));
    for (const [i, line] of lines.entries()) {
      ctx.fillStyle = /^\s*\$/.test(line) ? '#fff3a0' : '#f4f1e8';
      ctx.fillText(line, snap(panel.x + 4), snap(panel.y + 2 + i * lineHeight), Math.max(1, panel.width - 8));
    }
    ctx.restore();
  }
  drawPointer(ctx, sidebar, assets, transparentRects(sidebar, assets), opts.pointerPosition);
  ctx.restore();
}

/** Restore only the software-cursor pixels erased by the same union of native-frame holes. */
export function drawPointer(
  ctx: CanvasRenderingContext2D,
  sidebar: Sidebar,
  assets: UiAssets,
  covered: readonly Rect[],
  position?: Readonly<{ x: number; y: number }> | null,
): void {
  const pointer = sidebar.pointer;
  if (!pointer || !covered.length) return;
  const local =
    position &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x < sidebar.frame.width &&
    position.y < sidebar.frame.height
      ? position
      : pointer;
  const art = assets.cursor(pointer.frame);
  const x = art ? local.x - pointer.hotspot.x : local.x;
  const y = art ? local.y - pointer.hotspot.y : local.y;
  const width = art?.rect.width ?? 16,
    height = art?.rect.height ?? 22;
  if (!covered.some((r) => x < r.x + r.width && x + width > r.x && y < r.y + r.height && y + height > r.y)) return;
  ctx.save();
  ctx.beginPath();
  for (const r of covered) ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
  if (art) {
    const r = art.rect;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(art.bitmap, r.x, r.y, r.width, r.height, x, y, width, height);
  } else {
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 18);
    ctx.lineTo(4, 14);
    ctx.lineTo(8, 21);
    ctx.lineTo(11, 19);
    ctx.lineTo(7, 12);
    ctx.lineTo(14, 12);
    ctx.closePath();
    ctx.fillStyle = '#fff6d5';
    ctx.strokeStyle = '#090b10';
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fill();
  }
  ctx.restore();
}
