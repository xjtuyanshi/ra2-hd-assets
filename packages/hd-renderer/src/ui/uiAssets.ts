import type { Rect } from './sidebarView';

export interface CameoIndex {
  version: 1;
  images: Record<string, { hd?: string; orig?: string }>;
  byId: Record<string, string>;
}

export interface ChromeManifest {
  frame: { width: number; height: number };
  /** Rect x/y are frame-pixel offsets from the live anchor; width/height are frame-pixel sizes, independent of PNG scale. */
  pieces: { file: string; rect: Rect; anchor: 'sidebar' | 'commandBar' }[];
  /** Atlas rectangles are image pixels; the live layout supplies each button's frame-pixel destination. */
  tabs?: {
    file: string;
    scale: number;
    frames: { tab: number; state: 'normal' | 'active' | 'pressed'; rect: Rect }[];
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
  tabs?: NonNullable<ChromeManifest['tabs']> & { bitmap: ImageBitmap };
}

/** Getters are nonblocking: unavailable assets retain procedural drawing until a later frame. */
export interface UiAssets {
  cameo(id: string, image: string | null): ImageBitmap | null;
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
      if (disposed) return null;
      if (!indexStarted) {
        indexStarted = true;
        void json<CameoIndex>(`${base}/cameos/index.json`).then((value) => {
          if (!disposed && value?.version === 1 && value.images && value.byId) index = value;
        });
      }
      const name = index?.byId[id] ?? image;
      const entry = name ? index?.images[name] : null;
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
              chrome.set(side, assets);
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
                  !['normal', 'active', 'pressed'].includes(frame.state)
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
      bitmaps.clear();
      pending.clear();
      chrome.clear();
      index = null;
      cursor = null;
    },
  };
}
