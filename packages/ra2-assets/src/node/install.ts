/**
 * Mounts the player's own RA2/YR install (Node only) as one virtual file system with the engine's MIX priority.
 *
 * YR resolves a file from the first archive (in load order) that contains it. Load order, highest priority first:
 *   1. expandmd99.mix .. expandmd01.mix   (loose, game directory; patches such as the 1.001 rulesmd.ini)
 *   2. ra2md.mix, ra2.mix                 (loose)
 *   3. cachemd.mix, cache.mix, localmd.mix, local.mix
 *   4. ecachemd*.mix, ecache*.mix, elocal*.mix (loose, when present)
 *   5. langmd.mix, language.mix           (loose) and the audio/cameo mixes nested in them
 *   6. conqmd.mix, genermd.mix, generic.mix, isogenmd.mix, isogen.mix, conquer.mix, cameomd.mix, cameo.mix
 *   7. the map theater's mixes (iso<th>md.mix, iso<th>.mix, <theater>.mix, <ext>.mix)
 *   8. ntrlmd.mix, neutral.mix, loadmd.mix, load.mix, sidec*.mix (menu/sidebar art, never shadows game art)
 * Nested archives are looked up in every already-known archive. ra2-formats' Vfs lets LATER mounts shadow earlier
 * ones, so the list is mounted in reverse.
 *
 * Mount-order knowledge: ModEnc (MIX file load order) cross-checked against Vanguard
 * (harshilmathur/openra2 @ 8ba59f0, apps/client/dev/assetSource.ts, GPL-3.0-or-later).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { IniFile, MapFile, MixFile, Palette, ShpFile, TmpFile, Vfs, VxlFile, HvaFile, parseIni } from 'ra2-formats';
import { THEATERS, type TheaterId } from '../theater.ts';

export interface MountReport {
  /** Archives mounted, highest priority first. */
  mounted: string[];
  /** Archives of the load order that this install does not have. */
  missing: string[];
  /** Archives present but not MIX-readable (e.g. audio.mix, which is a raw bag/idx container). */
  unreadable: string[];
}

function readBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Case-insensitive lookup of a loose file in the game directory. */
function findLoose(dir: string, name: string, listing: string[]): string | undefined {
  const hit = listing.find((f) => f.toLowerCase() === name.toLowerCase());
  return hit ? join(dir, hit) : undefined;
}

export class GameInstall {
  private readonly vfs = new Vfs();
  private readonly archives = new Map<string, MixFile>();
  private readonly iniCache = new Map<string, IniFile>();
  private readonly shpCache = new Map<string, ShpFile | null>();
  private readonly tmpCache = new Map<string, TmpFile | null>();
  private readonly palCache = new Map<string, Palette>();
  readonly report: MountReport = { mounted: [], missing: [], unreadable: [] };

  private constructor(
    readonly dir: string,
    readonly theater: TheaterId,
  ) {}

  /** Mount `dir` for a map of `theater`. Throws when ra2.mix / ra2md.mix are missing. */
  static open(dir: string, theater: TheaterId): GameInstall {
    const inst = new GameInstall(dir, theater);
    inst.mountAll();
    return inst;
  }

  private mountAll(): void {
    const listing = readdirSync(this.dir);
    const loose = (name: string): MixFile | undefined => {
      const path = findLoose(this.dir, name, listing);
      if (!path) return undefined;
      const mix = MixFile.parse(readBytes(path));
      this.archives.set(name.toLowerCase(), mix);
      return mix;
    };
    const nested = (name: string): MixFile | undefined => {
      const key = name.toLowerCase();
      const known = this.archives.get(key);
      if (known) return known;
      if (this.report.unreadable.some((u) => u.startsWith(`${name}:`))) return undefined;
      for (const parent of [...this.archives.values()]) {
        const bytes = parent.read(key);
        if (bytes) {
          try {
            const mix = MixFile.parse(bytes);
            this.archives.set(key, mix);
            return mix;
          } catch (err) {
            this.report.unreadable.push(`${name}: ${(err as Error).message}`);
            return undefined;
          }
        }
      }
      return undefined;
    };

    const order: [string, MixFile | undefined][] = [];
    const expand = listing
      .filter((f) => /^expandmd\d\d\.mix$/i.test(f))
      .sort()
      .reverse();
    for (const f of expand) order.push([f, loose(f)]);
    for (const f of ['ra2md.mix', 'ra2.mix']) {
      const mix = loose(f);
      if (!mix) throw new Error(`${f} not found in ${this.dir}; point --game at a Yuri's Revenge install`);
      order.push([f, mix]);
    }
    for (const f of ['cachemd.mix', 'cache.mix', 'localmd.mix', 'local.mix']) order.push([f, nested(f)]);
    const ecache = listing.filter((f) => /^(ecachemd|ecache|elocal)\d*\.mix$/i.test(f)).sort();
    for (const f of ecache) order.push([f, loose(f)]);
    for (const f of ['langmd.mix', 'language.mix']) order.push([f, loose(f)]);
    for (const f of ['audiomd.mix', 'audio.mix']) order.push([f, nested(f)]);
    for (const f of [
      'conqmd.mix',
      'genermd.mix',
      'generic.mix',
      'isogenmd.mix',
      'isogen.mix',
      'conquer.mix',
      'cameomd.mix',
      'cameo.mix',
    ])
      order.push([f, nested(f)]);
    for (const f of THEATERS[this.theater].mixes) order.push([f, nested(f)]);
    for (const f of [
      'ntrlmd.mix',
      'neutral.mix',
      'loadmd.mix',
      'load.mix',
      'sidec02md.mix',
      'sidec01.mix',
      'sidec02.mix',
    ])
      order.push([f, nested(f)]);

    for (let i = order.length - 1; i >= 0; i--) {
      const mix = order[i]![1];
      if (mix) this.vfs.mount(mix);
    }
    for (const [name, mix] of order) {
      if (mix) this.report.mounted.push(name);
      else if (!this.report.unreadable.some((u) => u.startsWith(`${name}:`))) this.report.missing.push(name);
    }
  }

  has(name: string): boolean {
    return this.vfs.exists(name);
  }

  read(name: string): Uint8Array | undefined {
    return this.vfs.openFile(name);
  }

  /** Resolve an explicitly requested nested archive without mounting it into the shared file namespace. */
  readArchive(archive: string, name: string): Uint8Array | undefined {
    const key = archive.toLowerCase();
    let mix = this.archives.get(key);
    if (!mix) {
      for (const parent of [...this.archives.values()]) {
        const bytes = parent.read(key);
        if (bytes !== undefined) {
          // A present but malformed archive is an extraction failure, not a missing override.
          mix = MixFile.parse(bytes);
          this.archives.set(key, mix);
          break;
        }
      }
    }
    return mix?.read(name.toLowerCase());
  }

  ini(name: string): IniFile {
    const key = name.toLowerCase();
    let ini = this.iniCache.get(key);
    if (!ini) {
      const bytes = this.read(key);
      if (!bytes) throw new Error(`${name} not found in the mounted install`);
      ini = parseIni(bytes);
      this.iniCache.set(key, ini);
    }
    return ini;
  }

  palette(name: string): Palette {
    const key = name.toLowerCase();
    let pal = this.palCache.get(key);
    if (!pal) {
      const bytes = this.read(key);
      if (!bytes) throw new Error(`palette ${name} not found in the mounted install`);
      pal = Palette.parse(bytes);
      this.palCache.set(key, pal);
    }
    return pal;
  }

  /** Parsed SHP or undefined when absent/corrupt (never throws). */
  shp(name: string): ShpFile | undefined {
    const key = name.toLowerCase();
    if (!this.shpCache.has(key)) {
      const bytes = this.read(key);
      let parsed: ShpFile | null = null;
      if (bytes) {
        try {
          parsed = ShpFile.parse(bytes);
        } catch {
          parsed = null;
        }
      }
      this.shpCache.set(key, parsed);
    }
    return this.shpCache.get(key) ?? undefined;
  }

  tmp(name: string): TmpFile | undefined {
    const key = name.toLowerCase();
    if (!this.tmpCache.has(key)) {
      const bytes = this.read(key);
      let parsed: TmpFile | null = null;
      if (bytes) {
        try {
          parsed = TmpFile.parse(bytes);
        } catch {
          parsed = null;
        }
      }
      this.tmpCache.set(key, parsed);
    }
    return this.tmpCache.get(key) ?? undefined;
  }

  vxl(name: string): VxlFile | undefined {
    const bytes = this.read(name.toLowerCase());
    return bytes ? VxlFile.parse(bytes) : undefined;
  }

  hva(name: string): HvaFile | undefined {
    const bytes = this.read(name.toLowerCase());
    return bytes ? HvaFile.parse(bytes) : undefined;
  }
}

export interface LoadedMap {
  map: MapFile;
  /** Map id derived from the file name (e.g. "RiverRam"). */
  id: string;
  source: string;
  /** Display name from the package's .pkt ([<stem>] Description=) or [Basic] Name=. */
  name: string;
}

/** Map archives nested inside the top-level MIX files (multiplayer maps ship in multimd.mix / mapsmd*.mix). */
const NESTED_MAP_ARCHIVES = ['multimd.mix', 'mapsmd03.mix', 'maps02.mix', 'maps01.mix'];

/**
 * Find a map file stored inside the install's MIX archives: first directly in a top-level archive, then one nesting
 * level down in the known map archives. Most stock multiplayer maps (e.g. XMP29U2.MAP) only exist there.
 */
export function findArchivedMap(gameDir: string, name: string): { bytes: Uint8Array; source: string } | undefined {
  const archives = readdirSync(gameDir)
    .filter((f) => /\.mix$/i.test(f))
    .sort();
  for (const archive of archives) {
    let mix: MixFile;
    try {
      mix = MixFile.parse(readBytes(join(gameDir, archive)));
    } catch {
      continue;
    }
    const direct = mix.read(name);
    if (direct) return { bytes: direct, source: archive };
    for (const inner of NESTED_MAP_ARCHIVES) {
      const nested = mix.read(inner);
      if (!nested) continue;
      try {
        const found = MixFile.parse(nested).read(name);
        if (found) return { bytes: found, source: `${archive}/${inner}` };
      } catch {
        // An unreadable nested archive only means the map is not there.
      }
    }
  }
  return undefined;
}

/**
 * Open a map by path or by file name relative to the game directory (loose file first, then inside its MIX archives). `.yro`/`.mmx` packages are MIX archives holding
 * `<stem>.map` plus a `.pkt` index; plain `.map/.mpr/.yrm` files are INI text. A few unofficial `.yro` files are
 * plain INI text behind a short binary prefix, so as a last resort the text from the first line starting with `[`
 * is parsed.
 */
export function loadMap(gameDir: string, mapArg: string): LoadedMap {
  const path = existsSync(mapArg) ? mapArg : join(gameDir, mapArg);
  const listingHit = existsSync(path)
    ? path
    : (() => {
        const hit = readdirSync(gameDir).find((f) => f.toLowerCase() === mapArg.toLowerCase());
        return hit ? join(gameDir, hit) : undefined;
      })();
  const archived = listingHit ? undefined : findArchivedMap(gameDir, basename(mapArg));
  if (!listingHit && !archived)
    throw new Error(`map ${mapArg} not found (looked in the current directory, ${gameDir} and its MIX archives)`);
  const bytes = listingHit ? readBytes(listingHit) : archived!.bytes;
  const file = listingHit ? basename(listingHit) : basename(mapArg);
  const stem = basename(file, extname(file));
  const ext = extname(file).toLowerCase();

  let map: MapFile | undefined;
  let name = '';
  if (ext === '.yro' || ext === '.mmx') {
    try {
      map = MapFile.fromPackage(bytes, stem);
      const mix = MixFile.parse(bytes);
      const pkt = mix.read(`${stem.toLowerCase()}.pkt`);
      if (pkt) {
        const pktIni = parseIni(pkt);
        name = pktIni.getSection(stem)?.getString('Description', '') ?? '';
      }
    } catch {
      map = undefined;
    }
  }
  if (!map) {
    const text = new TextDecoder('latin1').decode(bytes);
    const m = /(^|\n)\s*\[/.exec(text);
    if (!m) throw new Error(`${file} contains no INI text`);
    map = MapFile.parse(text.slice(m.index));
  }
  if (!name) name = map.ini.getSection('Basic')?.getString('Name', '') ?? '';
  if (!name) name = stem;
  return { map, id: stem, source: file, name };
}
