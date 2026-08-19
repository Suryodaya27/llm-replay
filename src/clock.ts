/**
 * Virtual Clock — controls time during replay.
 *
 * Design pattern: Strategy pattern
 * Two implementations behind one interface:
 * - RealClock: passes through to Date.now() during capture
 * - VirtualClock: returns controlled timestamps during replay
 *
 * The proxy doesn't care which one it's using. Swap at mode switch time.
 *
 * Why this matters: during replay, we need `t` values in events to match
 * the original timing. The virtual clock lets us "fast-forward" or "pause"
 * without wall-clock dependency.
 */

export interface Clock {
  /** Current time in ms since epoch */
  now(): number;
  /** Elapsed ms since clock started */
  elapsed(): number;
  /** Reset the clock (new session) */
  reset(): void;
}

/** Real wall clock — used during capture mode */
export class RealClock implements Clock {
  private startedAt: number;

  constructor() {
    this.startedAt = Date.now();
  }

  now(): number {
    return Date.now();
  }

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  reset(): void {
    this.startedAt = Date.now();
  }
}

/**
 * Virtual clock — used during replay mode.
 * Time only advances when you tell it to (via `advance()` or `setElapsed()`).
 * This guarantees deterministic `t` values in replayed events.
 */
export class VirtualClock implements Clock {
  private startedAt: number;
  private currentElapsed: number;

  constructor(startedAt?: string) {
    this.startedAt = startedAt ? new Date(startedAt).getTime() : Date.now();
    this.currentElapsed = 0;
  }

  now(): number {
    return this.startedAt + this.currentElapsed;
  }

  elapsed(): number {
    return this.currentElapsed;
  }

  /** Jump to a specific elapsed time (used when serving event at known `t`) */
  setElapsed(ms: number): void {
    this.currentElapsed = ms;
  }

  /** Advance clock by delta ms */
  advance(ms: number): void {
    this.currentElapsed += ms;
  }

  reset(): void {
    this.currentElapsed = 0;
  }
}
