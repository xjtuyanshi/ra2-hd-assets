// Virtual filesystem over a stack of mounted MIX archives, with RA2/YR mount
// precedence. This is original Vanguard code; it composes the MixFile loader
// (which ports XCC) but implements no XCC logic itself.

import { idFromName } from './crc.js';
import { MixFile } from './mixFile.js';

/**
 * A virtual filesystem that resolves file names across several mounted MIX
 * archives. Later mounts shadow earlier ones, matching the RA2/YR convention
 * where expansion and language MIXes override the base game.
 *
 * The conventional load order (earliest to latest) is:
 *   ra2.mix -> ra2md.mix -> expandmd##.mix -> ecache/elocal -> language.mix
 *   -> langmd.mix
 * Mount in that order and the most-specific archive wins.
 */
export class Vfs {
  // Ordered list of mounts; index 0 is the earliest (lowest precedence).
  private readonly mounts: MixFile[] = [];

  /**
   * Mount a MIX archive. Later mounts take precedence over earlier ones for the
   * same file id. Returns the parsed MixFile so callers can inspect it.
   */
  mount(archive: MixFile): MixFile {
    this.mounts.push(archive);
    return archive;
  }

  /** Parse `data` as a MIX and mount it. Convenience over {@link mount}. */
  mountData(data: Uint8Array): MixFile {
    return this.mount(MixFile.parse(data));
  }

  /**
   * Mount a MIX that lives *inside* an already-mounted (or freestanding) MIX.
   * The inner archive is parsed from its slice of the outer buffer and mounted
   * at the top of the stack. Returns undefined if the inner file is absent.
   */
  mountNested(outer: MixFile, innerName: string): MixFile | undefined {
    const bytes = outer.read(innerName);
    if (!bytes) return undefined;
    return this.mount(MixFile.parse(bytes));
  }

  /**
   * Resolve a file by name, searching mounts from highest to lowest precedence.
   * Returns the file bytes or undefined if no mount contains it.
   */
  openFile(name: string): Uint8Array | undefined {
    const id = idFromName(name);
    for (let i = this.mounts.length - 1; i >= 0; i--) {
      const bytes = this.mounts[i]!.readById(id);
      if (bytes) return bytes;
    }
    return undefined;
  }

  /** True if any mount contains the named file. */
  exists(name: string): boolean {
    const id = idFromName(name);
    for (let i = this.mounts.length - 1; i >= 0; i--) {
      if (this.mounts[i]!.getEntryById(id)) return true;
    }
    return false;
  }

  /** Number of mounted archives. */
  get mountCount(): number {
    return this.mounts.length;
  }
}
