import type { Rect } from './sidebarView';

export interface CameoIndex {
  version: 1;
  images: Record<string, { hd?: string; orig?: string; caption?: string }>;
  byId: Record<string, string>;
}

export interface ChromeManifest {
  frame: { width: number; height: number };
  /** Rect x/y are frame-pixel offsets from the live anchor; width/height are frame-pixel sizes, independent of PNG scale. */
  pieces: { file: string; rect: Rect; anchor: 'sidebar' | 'commandBar' }[];
  /** Native ShapeButton frames: 0 normal, 1 active, 2 disabled, 3 pressed, 4 pressed-active. */
  controls?: { file: string; frames: { id: string; frame: number; rect: Rect }[] };
  /** Frame art has a transparent aperture; logo art covers only the native radar aperture. */
  radar?: { file: string; frames: { state: 'frame' | 'logo'; rect: Rect }[] };
  /** Atlas rectangles are image pixels; the live layout supplies each button's frame-pixel destination. */
  tabs?: {
    file: string;
    scale: number;
    frames: { tab: number; state: 'normal' | 'active' | 'pressed' | 'disabled' | 'pressedActive'; rect: Rect }[];
  };
}

export interface CursorManifest {
  version: 1;
  /** Relative atlas file; defaults to cursor.png. Frames include their transparent SHP bounding-box padding. */
  file?: string;
  frames: Rect[];
}

export interface ChromeAssets {
  frame: { width: number; height: number };
  pieces: (ChromeManifest['pieces'][number] & { bitmap: ImageBitmap })[];
  composites?: Partial<
    Record<ChromeManifest['pieces'][number]['anchor'], { rect: Rect; bitmap: ImageBitmap | HTMLCanvasElement }>
  >;
  tabs?: NonNullable<ChromeManifest['tabs']> & { bitmap: ImageBitmap };
  controls?: NonNullable<ChromeManifest['controls']> & { bitmap: ImageBitmap };
  radar?: NonNullable<ChromeManifest['radar']> & { bitmap: ImageBitmap };
}

/** Place an anchor's pieces without resampling; incompatible scales retain per-piece drawing. */
export function layoutChromeAnchor(pieces: readonly Pick<ChromeAssets['pieces'][number], 'rect' | 'bitmap'>[]): {
  rect: Rect;
  width: number;
  height: number;
  placements: Rect[];
} | null {
  if (!pieces.length) return null;
  const scale = pieces[0]!.bitmap.width / pieces[0]!.rect.width;
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  if (
    !pieces.every(
      ({ rect: r, bitmap }) =>
        r.width > 0 &&
        r.height > 0 &&
        bitmap.width / r.width === scale &&
        bitmap.height / r.height === scale &&
        [r.x, r.y, r.width, r.height].every((value) => Number.isInteger(value * scale)),
    )
  )
    return null;
  const x = Math.min(...pieces.map((piece) => piece.rect.x));
  const y = Math.min(...pieces.map((piece) => piece.rect.y));
  const width = Math.max(...pieces.map((piece) => piece.rect.x + piece.rect.width)) - x;
  const height = Math.max(...pieces.map((piece) => piece.rect.y + piece.rect.height)) - y;
  return {
    rect: { x, y, width, height },
    width: width * scale,
    height: height * scale,
    placements: pieces.map(({ rect: r, bitmap }) => ({
      x: (r.x - x) * scale,
      y: (r.y - y) * scale,
      width: bitmap.width,
      height: bitmap.height,
    })),
  };
}

function composeChrome(pieces: ChromeAssets['pieces']): NonNullable<ChromeAssets['composites']> {
  const composites: NonNullable<ChromeAssets['composites']> = {};
  for (const anchor of new Set(pieces.map((piece) => piece.anchor))) {
    const group = pieces.filter((piece) => piece.anchor === anchor);
    const layout = layoutChromeAnchor(group);
    if (!layout) continue;
    let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    try {
      canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(layout.width, layout.height)
          : typeof document !== 'undefined'
            ? document.createElement('canvas')
            : null;
      if (!canvas) continue;
      canvas.width = layout.width;
      canvas.height = layout.height;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) continue;
      ctx.imageSmoothingEnabled = false;
      group.forEach((piece, i) => {
        const r = layout.placements[i]!;
        ctx.drawImage(piece.bitmap, r.x, r.y, r.width, r.height);
      });
      const bitmap = 'transferToImageBitmap' in canvas ? canvas.transferToImageBitmap() : canvas;
      composites[anchor] = { rect: layout.rect, bitmap };
    } catch {
      // Optional composition failures retain the complete per-piece chrome.
    } finally {
      if (canvas && composites[anchor]?.bitmap !== canvas) canvas.width = canvas.height = 0;
    }
  }
  return composites;
}

/** Getters are nonblocking: unavailable assets retain procedural drawing until a later frame. */
export interface UiAssets {
  cameo(id: string, image: string | null): ImageBitmap | null;
  caption(id: string, image: string | null): string | null;
  chrome(side: number): ChromeAssets | null;
  cursor(frame: number): { bitmap: ImageBitmap; rect: Rect } | null;
}

/** One UI controller owns this cache and closes its bitmaps, including late results, on disposal. */
export function createUiAssets(base = '/hd-cache/_ui'): UiAssets & { dispose(): void } {
  const abort = new AbortController();
  const bitmaps = new Map<string, ImageBitmap | null>();
  const pending = new Map<string, Promise<ImageBitmap | null>>();
  const chrome = new Map<number, ChromeAssets | null>();
  let index: CameoIndex | null = null;
  let indexStarted = false;
  let disposed = false;
  let cursorStarted = false;
  let cursor: { bitmap: ImageBitmap; frames: Rect[] } | null = null;

  // Both failures and 404s are cached for this controller's lifetime; no per-frame retry loops.
  const json = async <T>(path: string): Promise<T | null> => {
    try {
      const response = await fetch(path, { signal: abort.signal });
      return response.ok ? ((await response.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const bitmap = (path: string): Promise<ImageBitmap | null> => {
    if (bitmaps.has(path)) return Promise.resolve(bitmaps.get(path)!);
    const existing = pending.get(path);
    if (existing) return existing;
    const request = (async () => {
      let value: ImageBitmap | null = null;
      try {
        const response = await fetch(path, { signal: abort.signal });
        if (response.ok) value = await createImageBitmap(await response.blob());
      } catch {
        // Optional art does not prevent the interface from drawing.
      }
      if (disposed) {
        value?.close();
        return null;
      }
      bitmaps.set(path, value);
      pending.delete(path);
      return value;
    })();
    pending.set(path, request);
    return request;
  };
  const cameoEntry = (id: string, image: string | null) => {
    if (disposed) return null;
    if (!indexStarted) {
      indexStarted = true;
      void json<CameoIndex>(`${base}/cameos/index.json`).then((value) => {
        if (!disposed && value?.version === 1 && value.images && value.byId) index = value;
      });
    }
    // The guest already chose primary versus Alternate Cameo. Preserve that choice when indexed.
    const name = image && index?.images[image] ? image : (index?.byId[id] ?? image);
    return name ? (index?.images[name] ?? null) : null;
  };
  const loadAtlas = async <T extends { file: string; frames: { rect: Rect }[] }>(
    dir: string,
    manifest: T | undefined,
    keyOf: (frame: T['frames'][number]) => string | null,
  ): Promise<(T & { bitmap: ImageBitmap }) | null> => {
    if (
      !manifest ||
      typeof manifest.file !== 'string' ||
      !/^[a-z0-9_-]+\.png$/i.test(manifest.file) ||
      !Array.isArray(manifest.frames) ||
      !manifest.frames.length ||
      manifest.frames.length > 512
    )
      return null;
    const image = await bitmap(`${dir}/${manifest.file}`);
    if (disposed || !image) return null;
    const keys = new Set<string>();
    const valid = manifest.frames.every((frame) => {
      if (!frame) return false;
      const key = keyOf(frame),
        r = frame.rect;
      if (
        key === null ||
        keys.has(key) ||
        !r ||
        ![r.x, r.y, r.width, r.height].every(Number.isInteger) ||
        r.x < 0 ||
        r.y < 0 ||
        r.width < 1 ||
        r.height < 1 ||
        r.x + r.width > image.width ||
        r.y + r.height > image.height
      )
        return false;
      keys.add(key);
      return true;
    });
    return valid ? { ...manifest, bitmap: image } : null;
  };
  return {
    cursor(frame) {
      if (disposed) return null;
      if (!cursorStarted) {
        cursorStarted = true;
        void json<CursorManifest>(`${base}/cursor/cursor.json`).then(async (manifest) => {
          if (disposed || manifest?.version !== 1 || !Array.isArray(manifest.frames) || !manifest.frames.length) return;
          const image = await bitmap(`${base}/cursor/${manifest.file ?? 'cursor.png'}`);
          if (disposed || !image) return;
          if (
            manifest.frames.every(
              (r) =>
                r &&
                typeof r === 'object' &&
                [r.x, r.y, r.width, r.height].every(Number.isInteger) &&
                r.x >= 0 &&
                r.y >= 0 &&
                r.width > 0 &&
                r.height > 0 &&
                r.x + r.width <= image.width &&
                r.y + r.height <= image.height,
            )
          ) {
            cursor = { bitmap: image, frames: manifest.frames };
          }
        });
      }
      const rect = Number.isInteger(frame) && frame >= 0 ? cursor?.frames[frame] : null;
      return cursor && rect ? { bitmap: cursor.bitmap, rect } : null;
    },
    cameo(id, image) {
      const entry = cameoEntry(id, image);
      if (!entry) return null;
      for (const file of [entry.hd, entry.orig]) {
        if (!file) continue;
        const path = `${base}/cameos/${file}`;
        if (!bitmaps.has(path)) {
          void bitmap(path);
          // Prefer HD while loading; fall back to original only after an unsuccessful HD load.
          return null;
        }
        const result = bitmaps.get(path);
        if (result) return result;
      }
      return null;
    },
    caption(id, image) {
      return cameoEntry(id, image)?.caption ?? null;
    },
    chrome(side) {
      if (disposed) return null;
      if (!chrome.has(side)) {
        chrome.set(side, null);
        const dir = `${base}/chrome/${side}`;
        void json<ChromeManifest>(`${dir}/chrome.json`).then(async (manifest) => {
          if (disposed || !manifest?.frame || !Array.isArray(manifest.pieces) || !manifest.pieces.length) return;
          try {
            const pieces = await Promise.all(
              manifest.pieces.map(async (piece) => ({
                ...piece,
                bitmap: await bitmap(`${dir}/${piece.file}`),
              })),
            );
            // Do not erase native chrome unless its complete replacement is available.
            if (!disposed && pieces.every((piece) => piece.bitmap)) {
              const assets: ChromeAssets = { frame: manifest.frame, pieces: pieces as ChromeAssets['pieces'] };
              assets.composites = composeChrome(assets.pieces);
              chrome.set(side, assets);
              // Optional atlases publish independently; one failure cannot suppress another feature.
              void loadAtlas(dir, manifest.controls, (frame) =>
                typeof frame.id === 'string' &&
                /^[a-z0-9_-]+$/i.test(frame.id) &&
                Number.isInteger(frame.frame) &&
                frame.frame >= 0 &&
                frame.frame <= 4
                  ? `${frame.id}:${frame.frame}`
                  : null,
              ).then((atlas) => {
                if (!disposed && atlas) assets.controls = atlas;
              });
              void loadAtlas(dir, manifest.radar, (frame) =>
                ['frame', 'logo'].includes(frame.state) ? frame.state : null,
              ).then((atlas) => {
                if (!disposed && atlas) assets.radar = atlas;
              });
              // Publish complete chrome first. Optional tab failures must never hide the other pieces.
              const tabs = manifest.tabs;
              if (
                !tabs ||
                typeof tabs.file !== 'string' ||
                !Number.isInteger(tabs.scale) ||
                tabs.scale < 1 ||
                !Array.isArray(tabs.frames)
              )
                return;
              const image = await bitmap(`${dir}/${tabs.file}`);
              if (disposed || !image) return;
              const keys = new Set<string>();
              const valid = tabs.frames.every((frame) => {
                if (
                  !frame ||
                  !Number.isInteger(frame.tab) ||
                  frame.tab < 0 ||
                  frame.tab > 3 ||
                  !['normal', 'active', 'pressed', 'disabled', 'pressedActive'].includes(frame.state)
                )
                  return false;
                const r = frame.rect,
                  key = `${frame.tab}:${frame.state}`;
                if (
                  !r ||
                  ![r.x, r.y, r.width, r.height].every(Number.isInteger) ||
                  r.x < 0 ||
                  r.y < 0 ||
                  r.width < 1 ||
                  r.height < 1 ||
                  r.x + r.width > image.width ||
                  r.y + r.height > image.height ||
                  keys.has(key)
                )
                  return false;
                keys.add(key);
                return true;
              });
              if (valid && [0, 1, 2, 3].every((tab) => keys.has(`${tab}:normal`) && keys.has(`${tab}:active`))) {
                assets.tabs = { ...tabs, bitmap: image };
              }
            }
          } catch {
            // Malformed optional manifests retain the fallback.
          }
        });
      }
      return chrome.get(side) ?? null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      for (const value of bitmaps.values()) value?.close();
      for (const assets of chrome.values()) {
        for (const composite of Object.values(assets?.composites ?? {})) {
          if ('close' in composite.bitmap) composite.bitmap.close();
          else composite.bitmap.width = composite.bitmap.height = 0;
        }
      }
      bitmaps.clear();
      pending.clear();
      chrome.clear();
      index = null;
      cursor = null;
    },
  };
}
