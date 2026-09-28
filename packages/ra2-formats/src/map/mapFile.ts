// RA2/YR scenario (.map/.mpr/.yrm) parser and .mmx/.yro package opener.
//
// Reuses the package's Westwood INI parser and MIX VFS. Terrain/overlay decode
// logic is verified against the FinalSun/FinalAlert 2 Mission Editor by Matthias
// Wagner (GPLv3) — MissionEditor/MapData.cpp and
// MissionEditorPackLib/MissionEditorPackLib.cpp.

import { IniFile, IniSection, parseIni } from '../ini/iniFile.js';
import { MixFile } from '../mix/mixFile.js';
import { decodeIsoMapPack, type IsoTile } from './isoMapPack.js';
import {
  decodeOverlayPack,
  OVERLAY_ARRAY_SIZE,
  OVERLAY_MAP_DIM,
} from './overlayPack.js';

/**
 * A 4-tuple `X,Y,Width,Height` as stored in `[Map] Size` / `LocalSize`.
 */
export interface MapSize {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A `[Terrain]` object entry: a neutral map decoration (tree, rock, sign, light
 * pole, ...). The section key is the packed cell `y*1000 + x` (the same packing
 * `[Waypoints]` uses); the value is the TerrainType id (e.g. `TREE07`) whose art
 * and rules live in `[TerrainTypes]` / artmd.
 */
export interface TerrainObject {
  /** TerrainType id (e.g. `TREE07`). */
  readonly type: string;
  /** Decoded cell X (`packedCell % 1000`). */
  readonly x: number;
  /** Decoded cell Y (`floor(packedCell / 1000)`). */
  readonly y: number;
}

/** A named waypoint: its number and the cell index it maps to. */
export interface Waypoint {
  /** Waypoint number (the key in `[Waypoints]`). */
  readonly number: number;
  /** Packed cell value as stored (`y * 1000 + x` in RA2's convention). */
  readonly cell: number;
  /** Decoded X coordinate (`cell % 1000`). */
  readonly x: number;
  /** Decoded Y coordinate (`floor(cell / 1000)`). */
  readonly y: number;
}

/**
 * A raw object-list entry from `[Structures]`, `[Units]`, `[Infantry]`, or
 * `[Aircraft]`. The value is kept as its split-on-comma fields with named
 * accessors for the common leading columns; callers needing the full shape read
 * {@link fields} directly.
 */
export class ObjectEntry {
  constructor(
    /** The entry's key (a positional index for these list sections). */
    readonly key: string,
    /** All comma-separated fields, trimmed. */
    readonly fields: readonly string[],
  ) {}

  /** Owner house name (field 0), or `''`. */
  get owner(): string {
    return this.fields[0] ?? '';
  }

  /** Object type id (field 1), or `''`. */
  get type(): string {
    return this.fields[1] ?? '';
  }

  /** Health 0..256 (field 2) as an integer, or `undefined` if unparsable. */
  get health(): number | undefined {
    return intOrUndef(this.fields[2]);
  }

  /** Cell X (field 3) as an integer, or `undefined`. */
  get x(): number | undefined {
    return intOrUndef(this.fields[3]);
  }

  /** Cell Y (field 4) as an integer, or `undefined`. */
  get y(): number | undefined {
    return intOrUndef(this.fields[4]);
  }
}

function intOrUndef(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^[+-]?\d+/.exec(raw.trim());
  if (!m) return undefined;
  const n = Number.parseInt(m[0], 10);
  return Number.isNaN(n) ? undefined : n;
}

function parseSize(raw: string): MapSize | undefined {
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length < 4) return undefined;
  const nums = parts.slice(0, 4).map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n))) return undefined;
  return { x: nums[0]!, y: nums[1]!, width: nums[2]!, height: nums[3]! };
}

/**
 * A parsed RA2/YR scenario map. Wraps the underlying {@link IniFile} and exposes
 * lazily-decoded terrain and overlay data.
 */
export class MapFile {
  /** The parsed INI backing this map. All sections remain accessible. */
  readonly ini: IniFile;

  private _tiles?: IsoTile[];
  private _tilesRaw?: Uint8Array;
  private _overlay?: Uint8Array;
  private _overlayData?: Uint8Array;

  private constructor(ini: IniFile) {
    this.ini = ini;
  }

  /**
   * Parse a `.map`/`.mpr`/`.yrm` scenario from its INI text or windows-1252
   * bytes.
   */
  static parse(input: string | Uint8Array): MapFile {
    return new MapFile(parseIni(input));
  }

  /**
   * Open a `.mmx`/`.yro` package (a MIX archive containing the scenario's `.map`
   * plus a `.pkt`) and parse the embedded scenario.
   *
   * The scenario's internal name is `<packageStem>.map` (e.g. `Arena.mmx`
   * contains `arena.map`). Provide `stem` to override when the internal name
   * differs from the archive's basename.
   *
   * @param data the raw `.mmx`/`.yro` bytes.
   * @param stem the package basename without extension (used to locate the
   *   embedded `.map`).
   * @throws {Error} if the archive holds no matching `.map`.
   */
  static fromPackage(data: Uint8Array, stem: string): MapFile {
    const mix = MixFile.parse(data);
    const lower = stem.toLowerCase();
    const readScenario = (name: string): Uint8Array | undefined =>
      mix.read(`${name}.map`) ??
      mix.read(`${name}.mpr`) ??
      mix.read(`${name}.yrm`);

    let mapBytes = readScenario(lower);
    if (!mapBytes) {
      // Fall back to the package's `<stem>.pkt` [MultiMaps] index, which lists
      // the embedded scenario name(s) when they differ from the archive stem
      // (e.g. `amazon.mmx` holds `amazon01.map` indexed by `amazon.pkt`).
      const pktBytes = mix.read(`${lower}.pkt`);
      if (pktBytes) {
        const pkt = parseIni(pktBytes);
        const multiMaps = pkt.getSection('MultiMaps');
        if (multiMaps) {
          for (const entry of multiMaps.entries) {
            const scenario = entry.value.trim();
            if (scenario.length === 0) continue;
            mapBytes = readScenario(scenario.toLowerCase());
            if (mapBytes) break;
          }
        }
      }
    }

    if (!mapBytes) {
      throw new Error(`package contains no ${lower}.map/.mpr/.yrm scenario`);
    }
    return MapFile.parse(mapBytes);
  }

  /** The `[Map]` section, or `undefined` if the file has none. */
  get mapSection(): IniSection | undefined {
    return this.ini.getSection('Map');
  }

  /** The theater name from `[Map] Theater` (e.g. `URBAN`, `TEMPERATE`). */
  get theater(): string {
    return this.mapSection?.getString('Theater') ?? '';
  }

  /** `[Map] Size` as a {@link MapSize}, or `undefined` if missing/malformed. */
  get size(): MapSize | undefined {
    const raw = this.mapSection?.getString('Size');
    return raw ? parseSize(raw) : undefined;
  }

  /** `[Map] LocalSize` (the visible playable region), or `undefined`. */
  get localSize(): MapSize | undefined {
    const raw = this.mapSection?.getString('LocalSize');
    return raw ? parseSize(raw) : undefined;
  }

  /**
   * The decoded `[IsoMapPack5]` terrain tiles. Empty when the section is absent.
   * Decoded once and cached.
   */
  get tiles(): IsoTile[] {
    if (this._tiles === undefined) this.decodeTerrain();
    return this._tiles!;
  }

  /**
   * The raw uncompressed `[IsoMapPack5]` byte buffer (11-byte records). Empty
   * when the section is absent.
   */
  get isoMapRaw(): Uint8Array {
    if (this._tilesRaw === undefined) this.decodeTerrain();
    return this._tilesRaw!;
  }

  private decodeTerrain(): void {
    const sec = this.ini.getSection('IsoMapPack5');
    if (!sec) {
      this._tiles = [];
      this._tilesRaw = new Uint8Array(0);
      return;
    }
    const lines = sec.entries.map((e) => e.value);
    const { tiles, raw } = decodeIsoMapPack(lines);
    this._tiles = tiles;
    this._tilesRaw = raw;
  }

  /**
   * The decoded `[OverlayPack]` array (262144 bytes, `y*512+x`). Cells with no
   * overlay hold `0xFF`. Always returns a full-size array even when the section
   * is absent (all `0xFF`).
   */
  get overlay(): Uint8Array {
    if (this._overlay === undefined) {
      const sec = this.ini.getSection('OverlayPack');
      this._overlay = decodeOverlayPack(sec ? sec.entries.map((e) => e.value) : []);
    }
    return this._overlay;
  }

  /**
   * The decoded `[OverlayDataPack]` array (262144 bytes, `y*512+x`). Absent
   * section → all `0xFF`.
   */
  get overlayData(): Uint8Array {
    if (this._overlayData === undefined) {
      const sec = this.ini.getSection('OverlayDataPack');
      this._overlayData = decodeOverlayPack(
        sec ? sec.entries.map((e) => e.value) : [],
      );
    }
    return this._overlayData;
  }

  /**
   * Parsed `[Waypoints]`. Each entry decodes RA2's `cell = y*1000 + x` packing.
   * Waypoint 98 is conventionally the player start; the raw list is preserved.
   */
  get waypoints(): Waypoint[] {
    const sec = this.ini.getSection('Waypoints');
    if (!sec) return [];
    const out: Waypoint[] = [];
    for (const e of sec.entries) {
      const number = Number.parseInt(e.key, 10);
      const cell = Number.parseInt(e.value, 10);
      if (Number.isNaN(number) || Number.isNaN(cell)) continue;
      out.push({ number, cell, x: cell % 1000, y: Math.floor(cell / 1000) });
    }
    return out;
  }

  /**
   * Parsed `[Terrain]` neutral objects (trees, rocks, signs, poles). Each entry's
   * key decodes RA2's `cell = y*1000 + x` packing (the same as `[Waypoints]`);
   * malformed keys/values are skipped. Empty when the section is absent.
   */
  get terrainObjects(): TerrainObject[] {
    const sec = this.ini.getSection('Terrain');
    if (!sec) return [];
    const out: TerrainObject[] = [];
    for (const e of sec.entries) {
      const cell = Number.parseInt(e.key, 10);
      const type = e.value.trim();
      if (Number.isNaN(cell) || type.length === 0) continue;
      out.push({ type, x: cell % 1000, y: Math.floor(cell / 1000) });
    }
    return out;
  }

  /** Raw `[Structures]` entries. */
  get structures(): ObjectEntry[] {
    return this.objectList('Structures');
  }

  /** Raw `[Units]` (vehicle) entries. */
  get units(): ObjectEntry[] {
    return this.objectList('Units');
  }

  /** Raw `[Infantry]` entries. */
  get infantry(): ObjectEntry[] {
    return this.objectList('Infantry');
  }

  /** Raw `[Aircraft]` entries. */
  get aircraft(): ObjectEntry[] {
    return this.objectList('Aircraft');
  }

  private objectList(section: string): ObjectEntry[] {
    const sec = this.ini.getSection(section);
    if (!sec) return [];
    return sec.entries.map(
      (e) => new ObjectEntry(e.key, e.value.split(',').map((p) => p.trim())),
    );
  }

  /**
   * Whether the map carries an embedded preview image (`[Preview]` and
   * `[PreviewPack]` sections present).
   */
  get hasPreview(): boolean {
    return this.ini.hasSection('Preview') && this.ini.hasSection('PreviewPack');
  }
}

export { OVERLAY_ARRAY_SIZE, OVERLAY_MAP_DIM };
export type { IsoTile };
