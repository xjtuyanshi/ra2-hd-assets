/** Drawing-buffer-independent primitives captured with one native picture. No game addresses or inferred anchors. */
export interface FrameOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FrameOverlayPaint {
  /** Native RGB565, expanded by the same bit replication as the native picture. */
  colour: number;
  clip: FrameOverlayRect;
}

export type FrameOverlayCommand = FrameOverlayPaint &
  (({ kind: 'rect' } & FrameOverlayRect) | { kind: 'polygon'; points: readonly { x: number; y: number }[] });

/** The original picture remains the complete fallback; this pair is useful only as one atomic publication. */
export interface FrameOverlayJournal {
  matchGeneration: number;
  drawGeneration: number;
  width: number;
  height: number;
  cleanRgb565: Uint16Array;
  commands: readonly FrameOverlayCommand[];
}

interface OverlayPicture {
  width: number;
  height: number;
  matchGeneration?: number;
  drawGeneration?: number;
  rgb565?: Uint16Array;
  rgba?: Uint8Array;
  menuVisible?: boolean;
}

const generation = (value: number) => Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
const coordinate = (value: number) => Number.isInteger(value) && Math.abs(value) <= 65535;

function rectangle(value: FrameOverlayRect): boolean {
  return (
    !!value &&
    coordinate(value.x) &&
    coordinate(value.y) &&
    Number.isInteger(value.width) &&
    value.width > 0 &&
    value.width <= 65535 &&
    Number.isInteger(value.height) &&
    value.height > 0 &&
    value.height <= 65535
  );
}

/** Reject the complete replacement when even one command is unknown; never expose a partially erased picture. */
export function validFrameOverlay(picture: OverlayPicture, journal: FrameOverlayJournal): boolean {
  if (
    !journal ||
    picture.menuVisible ||
    picture.rgba ||
    !picture.rgb565 ||
    !generation(journal.matchGeneration) ||
    !generation(journal.drawGeneration) ||
    journal.matchGeneration !== picture.matchGeneration ||
    journal.drawGeneration !== picture.drawGeneration ||
    journal.width !== picture.width ||
    journal.height !== picture.height ||
    !Number.isInteger(journal.width) ||
    !Number.isInteger(journal.height) ||
    journal.width < 1 ||
    journal.height < 1 ||
    !(journal.cleanRgb565 instanceof Uint16Array) ||
    journal.cleanRgb565.length !== journal.width * journal.height ||
    picture.rgb565.length !== journal.cleanRgb565.length ||
    !Array.isArray(journal.commands) ||
    journal.commands.length < 1 ||
    journal.commands.length > 4096
  )
    return false;
  for (const command of journal.commands) {
    if (
      !command ||
      !Number.isInteger(command.colour) ||
      command.colour < 0 ||
      command.colour > 65535 ||
      !rectangle(command.clip)
    )
      return false;
    if (command.kind === 'rect') {
      if (!rectangle(command)) return false;
    } else if (command.kind === 'polygon') {
      const points = command.points;
      if (!Array.isArray(points) || points.length < 3 || points.length > 32) return false;
      if (points.some((point) => !point || !coordinate(point.x) || !coordinate(point.y))) return false;
      let direction = 0;
      for (let index = 0; index < points.length; index++) {
        const a = points[index]!,
          b = points[(index + 1) % points.length]!;
        if (a.x === b.x && a.y === b.y) return false;
        for (const c of points) {
          const turn = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          if (turn) {
            if (direction && Math.sign(turn) !== direction) return false;
            direction = Math.sign(turn);
          }
        }
      }
      if (!direction) return false;
    } else return false;
  }
  return true;
}
