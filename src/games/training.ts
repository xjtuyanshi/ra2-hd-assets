import type { GameCommandState } from './commandState';

/**
 * Practice lessons: the contract between a game's lesson definitions, the generic lesson engine
 * (src/app/training/lessonRun.ts) and the page. A lesson is an ordered list of tasks; every task is recognised by a
 * detector that looks at what the player really pressed and clicked together with the live order state of the game.
 * Nothing here knows a particular game: game modules build lessons from their own facts (YR: src/games/yr/training).
 *
 * Lesson texts are written in the Chinese source language of the UI catalog and are translated at the presentation
 * boundary (localizeText), so game modules stay free of UI imports.
 */

/** One thing the player did with the keyboard or the mouse, as the game received it. */
export interface TrainingInput {
  /** Host clock in milliseconds (the same clock as TrainingSample.time). */
  time: number;
  /**
   * What was pressed: a KeyboardEvent.code ("KeyT", "Digit1", "ArrowLeft", "Space"), or for the mouse "Mouse0" /
   * "Mouse2" (left / right button pressed), "Double0" (second left press at the same place within the double-click
   * time), "Drag0" / "Drag2" (button released after the pointer travelled: a box selection, a drag scroll).
   */
  code: string;
  /** Modifier keys as the game sees them (a page-level modifier mapping is already applied). */
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Guest frame pixel of a mouse input. */
  x?: number;
  y?: number;
}

/** Modifiers and code as one comparable name: "Ctrl+Digit1", "Ctrl+Shift+Mouse0", "KeyT". */
export function trainingChord(input: Pick<TrainingInput, 'code' | 'ctrl' | 'alt' | 'shift'>): string {
  return `${input.ctrl ? 'Ctrl+' : ''}${input.alt ? 'Alt+' : ''}${input.shift ? 'Shift+' : ''}${input.code}`;
}

/** What the engine is fed, a few times a second. */
export interface TrainingSample {
  /** Host clock in milliseconds. */
  time: number;
  /** Null while the game is not in a battle (loading, a menu page over the battle). */
  state: GameCommandState | null;
  /** Inputs since the previous sample, oldest first. */
  inputs: readonly TrainingInput[];
}

/** What a detector sees. `state` is never null here: the engine does not run detectors without a battle. */
export interface TrainingContext {
  time: number;
  state: GameCommandState;
  /** The state when the task became active. */
  origin: GameCommandState;
  /** The sample time when the task became active. */
  originTime: number;
  /** Every input since the task became active, oldest first (bounded by the engine). */
  inputs: readonly TrainingInput[];
  /** Scratch values of this task, kept between samples and dropped when the task ends. */
  memo: Map<string, unknown>;
}

/**
 * True (or 1) when the task is done. A number below 1 reports partial progress: the engine restarts the hint timer
 * whenever it grows, so a hint only appears after a stretch without progress.
 */
export type TrainingDetector = (context: TrainingContext) => boolean | number;

export interface TrainingTask {
  id: string;
  /** Short name of the operation, shown in the task list. */
  title: string;
  /** What to do, one or two sentences. */
  instruction: string;
  /** Shown after `hintAfterMs` without progress. */
  hint: string;
  hintAfterMs?: number;
  detect: TrainingDetector;
}

/** A hotkey or mouse operation a lesson teaches, for the summary's "used / not used" lists. */
export interface TrainingHotkey {
  /** Chords that count as this operation (see trainingChord). */
  chords: readonly string[];
  /** What the player reads, for example "Ctrl+1 建立编队". */
  label: string;
}

export interface TrainingLesson {
  id: string;
  title: string;
  /** One sentence for the lesson picker. */
  summary: string;
  /** Name of the prepared scenario the lesson is played on (a folder the launcher serves; see the lesson guide). */
  scenario: string;
  tasks: readonly TrainingTask[];
  hotkeys: readonly TrainingHotkey[];
  /** Optional: true once the scenario is ready for the first task (for example the lesson's units were handed over). */
  ready?: (state: GameCommandState) => boolean;
}
