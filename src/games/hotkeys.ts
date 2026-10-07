/**
 * A game's key and mouse operations as a player-facing cheat sheet: plain data a game module provides from its own
 * facts (YR: src/games/yr/hotkeys.ts) and the page shows in an overlay. Texts are Chinese source strings, translated
 * at the presentation boundary.
 */
export interface GameHotkeyRow {
  /** The key or mouse operation on a PC keyboard, for example "Ctrl+1…0". */
  keys: string;
  /** The same on an Apple keyboard when it differs, for example "⌘+1…0". */
  macKeys?: string;
  /** What it does. */
  action: string;
  /** When a good player uses it, one sentence. */
  tip: string;
}

export interface GameHotkeyGroup {
  title: string;
  rows: readonly GameHotkeyRow[];
}

export interface GameHotkeySheet {
  groups: readonly GameHotkeyGroup[];
  /** Things to know about this setup, shown under the table. */
  notes: readonly string[];
}
