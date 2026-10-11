/** Read-only guest window metadata. Coordinates use the original picture's pixels. */
export interface MenuControlSnapshot {
  hwnd: number;
  parent: number;
  id: number;
  className: string;
  style: number;
  /** The game's original text, including untranslated resource keys where present. */
  text: string;
  /** Untranslated cached title retained when a game policy supplies its actual drawn text. */
  sourceText?: string;
  textComplete: boolean;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
  enabled: boolean;
  focused: boolean;
  pressed: boolean;
  items?: string[];
  selection?: number | null;
}

/** Unknown, truncated or changing dialog trees must retain the complete original picture. */
export interface MenuSnapshot {
  width: number;
  height: number;
  dialogHwnd: number;
  complete: boolean;
  moviePlaying: boolean | null;
  pointer: { x: number; y: number };
  controls: MenuControlSnapshot[];
}
