/** Small disconnected water objects keep the painted tile, including pools and their lane markings.
 * Work on a coarse mask to bound memory on whole-map textures. No map-name or colour assumption is needed.
 */
export function paintedWaterMask(
  mask: { data: ArrayLike<number>; width: number; height: number },
  pixelsPerGamePixel: number,
  step = 4,
): { data: Uint8Array; width: number; height: number } {
  const width = Math.ceil(mask.width / step),
    height = Math.ceil(mask.height / step);
  const seen = new Uint8Array(width * height),
    data = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const limit = 8 * 1800 * (pixelsPerGamePixel / step) ** 2;
  const wet = (i: number) =>
    mask.data[
      Math.min(mask.height - 1, Math.floor(i / width) * step) * mask.width +
        Math.min(mask.width - 1, (i % width) * step)
    ]! >= 128;
  for (let seed = 0; seed < seen.length; seed++) {
    if (seen[seed] || !wet(seed)) continue;
    let head = 0,
      tail = 1,
      boundary = false;
    queue[0] = seed;
    seen[seed] = 1;
    while (head < tail) {
      const at = queue[head++]!,
        x = at % width,
        y = Math.floor(at / width);
      boundary ||= x === 0 || y === 0 || x === width - 1 || y === height - 1;
      for (const next of [
        x > 0 ? at - 1 : -1,
        x + 1 < width ? at + 1 : -1,
        y > 0 ? at - width : -1,
        y + 1 < height ? at + width : -1,
      ]) {
        if (next < 0 || seen[next] || !wet(next)) continue;
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
    if (!boundary && tail <= limit) for (let i = 0; i < tail; i++) data[queue[i]!] = 255;
  }
  return { data, width, height };
}
