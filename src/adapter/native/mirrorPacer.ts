/**
 * Paces native mirror captures to what readers actually consume.
 *
 * The agent captures the complete subscribed image on the game's logic thread whenever it holds a publication credit,
 * and a credit returns only with the client's ACK. Acknowledging every publication on arrival therefore makes the game
 * pay for a full capture on every logic frame, although no reader looks at most of those images: in the original
 * picture almost nothing reads them, and a slow HD page reads only a fraction. On large maps that capture is the game
 * thread's largest added cost (see docs/remaster/NATIVE_HOST.md, "Capture pacing").
 *
 * The pacer withholds the ACK of complete publications that no reader has consumed yet, so the agent captures again
 * only after a reader has used an image. With a two-entry window the most recently consumed publication also keeps its
 * credit until a newer one is consumed: exactly one capture stays ahead of the reader and is ready when the reader
 * returns. Images are never altered or reordered; only the timing of credits changes. Anything that needs a newer image
 * promptly (a mirror waiter, a subscription barrier, an incomplete publication) releases every withheld credit, and
 * when no reader makes progress for `holdMs` every credit is returned as well.
 */
export interface NativeMirrorPacerOptions {
  /** Send the ACK for one publication's logic frame. ACKs are always sent in arrival order. */
  readonly acknowledge: (frame: number) => void;
  /** Negotiated number of outstanding publications (1 legacy, 2 with the window capability). */
  readonly window: () => number;
  /** Longest time without reader progress before every credit is returned; bounds how stale an unread image gets. */
  readonly holdMs: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

interface HeldPublication {
  readonly frame: number;
  readonly publication: number;
}

export interface NativeMirrorPacerCounters {
  /** Complete publications whose ACK was withheld on arrival. */
  held: number;
  /** Releases forced by the hold limit (no reader progress) rather than by consumption or a barrier. */
  holdTimeouts: number;
  /** Releases requested because something needed a newer image promptly. */
  barrierReleases: number;
}

export class NativeMirrorPacer {
  private readonly held: HeldPublication[] = [];
  private consumed = -1;
  private timer: unknown = null;
  readonly counters: NativeMirrorPacerCounters = { held: 0, holdTimeouts: 0, barrierReleases: 0 };

  constructor(private readonly options: NativeMirrorPacerOptions) {}

  /** Number of publications whose credit is currently withheld. */
  get holding(): number {
    return this.held.length;
  }

  /**
   * A publication was applied. Incomplete (truncated or invalid) publications are acknowledged at once, together with
   * everything withheld: the agent reports or retries a failed capture only after its window has drained.
   */
  arrived(frame: number, publication: number, complete: boolean): void {
    if (!complete) {
      this.release();
      this.options.acknowledge(frame);
      return;
    }
    this.held.push({ frame, publication });
    this.counters.held++;
    this.settle();
  }

  /** A reader started on the image of `publication` (a complete publication already applied). */
  consume(publication: number): void {
    if (publication <= this.consumed) return;
    this.consumed = publication;
    // The hold limit measures time without reader progress, not the age of a credit kept for the next capture.
    this.cancelTimer();
    this.settle();
  }

  /** Something needs a newer image promptly: return every withheld credit now. */
  releaseForBarrier(): void {
    if (!this.held.length) return;
    this.counters.barrierReleases++;
    this.release();
  }

  /** Forget withheld credits without acknowledging them (the connection that owned them is gone). */
  reset(): void {
    this.held.length = 0;
    this.consumed = -1;
    this.cancelTimer();
  }

  private settle(): void {
    // Publications arrive in increasing order, so the released ones always form a prefix. A consumed publication
    // keeps its credit only when the window has another credit for the next capture; a single-entry window must
    // return it, or no further capture could start.
    const keepConsumed = this.options.window() > 1;
    while (this.held.length) {
      const { frame, publication } = this.held[0]!;
      if (publication > this.consumed || (keepConsumed && publication === this.consumed)) break;
      this.held.shift();
      this.options.acknowledge(frame);
    }
    this.arm();
  }

  private release(): void {
    for (const entry of this.held.splice(0)) this.options.acknowledge(entry.frame);
    this.cancelTimer();
  }

  private arm(): void {
    if (!this.held.length) {
      this.cancelTimer();
      return;
    }
    if (this.timer !== null) return;
    const set = this.options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    this.timer = set(() => {
      this.timer = null;
      if (!this.held.length) return;
      this.counters.holdTimeouts++;
      this.release();
    }, this.options.holdMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    const clear = this.options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    clear(this.timer);
    this.timer = null;
  }
}
