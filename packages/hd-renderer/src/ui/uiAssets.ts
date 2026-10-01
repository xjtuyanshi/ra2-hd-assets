import type { Rect } from './sidebarView';

export interface CameoIndex {
  version: 1;
  images: Record<string, { hd?: string; orig?: string }>;
  byId: Record<string, string>;
}

export interface ChromeManifest {
  frame: { width: number; height: number };
  pieces: { file: string; rect: Rect; anchor: 'sidebar' | 'commandBar' }[];
}

export interface ChromeAssets {
  frame: { width: number; height: number };
  pieces: (ChromeManifest['pieces'][number] & { bitmap: ImageBitmap })[];
}

/** Getters are nonblocking: unavailable assets retain procedural drawing until a later frame. */
export interface UiAssets {
  cameo(id: string, image: string | null): ImageBitmap | null;
  chrome(side: number): ChromeAssets | null;
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
              chrome.set(side, { frame: manifest.frame, pieces: pieces as ChromeAssets['pieces'] });
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
    },
  };
}
