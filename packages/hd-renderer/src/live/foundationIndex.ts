/** Cell-aligned rectangular foundations, with a strict inset at their exterior edges. */
export class FoundationIndex {
  // Nine subregions per cell (low edge, middle, high edge on each axis). OR combines overlapping foundations
  // without a candidate list: a query has one cell lookup and one bit test, independent of building count.
  private readonly cells = new Map<string, number>();

  constructor(private readonly inset = 0.05) {}

  add(x: number, z: number, w: number, h: number): void {
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        let mask = 0;
        for (let iz = 0; iz < 3; iz++) {
          if ((dz === 0 && iz === 0) || (dz === h - 1 && iz === 2)) continue;
          for (let ix = 0; ix < 3; ix++) {
            if ((dx === 0 && ix === 0) || (dx === w - 1 && ix === 2)) continue;
            mask |= 1 << (iz * 3 + ix);
          }
        }
        const key = `${x + dx},${z + dz}`;
        this.cells.set(key, (this.cells.get(key) ?? 0) | mask);
      }
    }
  }

  contains(x: number, z: number): boolean {
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    // Compare world-coordinate bounds directly: subtracting a large cell origin can round an exact inset inward.
    const region = (value: number, cell: number) =>
      value <= cell + this.inset ? 0 : value >= cell + 1 - this.inset ? 2 : 1;
    const bit = 1 << (region(z, cz) * 3 + region(x, cx));
    return ((this.cells.get(`${cx},${cz}`) ?? 0) & bit) !== 0;
  }
}
