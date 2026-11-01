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
  checked?: number;
  itemsComplete?: boolean;
  itemData?: number[];
  itemColors?: Array<number | null>;
  topIndex?: number;
  itemHeight?: number;
  visibleRows?: number;
  /** Complete caret-only edit state; absent while selection/composition is unknown. */
  edit?: {
    caret: number;
    firstVisible: number;
    caretVisible: boolean;
    /** RGB888 captured from the original caret painter. */
    caretColor: number;
  };
  /** An enumerated custom popup fully represented by its source combo. */
  popupOwner?: number;
  popup?: {
    hwnd?: number;
    selection?: number;
    scrollbarHwnd?: number;
    dropped: boolean;
    rect: { x: number; y: number; width: number; height: number };
    topIndex: number;
  };
  slider?: {
    min: number;
    max: number;
    value: number;
    valueText?: string;
    thumb?: { x: number; y: number; width: number; height: number };
    groove?: { x: number; y: number; width: number; height: number };
  };
  scroll?: {
    min: number;
    max: number;
    page: number;
    pos: number;
    arrowSize?: number;
    thumb?: { x: number; y: number; width: number; height: number };
    groove?: { x: number; y: number; width: number; height: number };
  };
}

/** Unknown, truncated or changing dialog trees must retain the complete original picture. */
export interface MenuSnapshot {
  /** Nonzero identity shared only with pictures captured with this exact complete control state. */
  generation?: number;
  width: number;
  height: number;
  dialogHwnd: number;
  complete: boolean;
  moviePlaying: boolean | null;
  pointer: { x: number; y: number };
  controls: MenuControlSnapshot[];
}
