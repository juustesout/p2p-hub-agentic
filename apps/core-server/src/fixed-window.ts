/**
 * Minimal fixed-window rate limiter: `limit` allowed calls per rolling
 * `windowMs`, in-memory, single instance. Rejected calls are not recorded (a
 * burst of rejects when over the cap cannot extend the window). Purely local
 * bookkeeping — a call that returned `false` is the caller's signal to refuse
 * without performing the gated action.
 */
export class FixedWindowLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record and allow the call, or refuse it without recording. */
  allow(): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    // In-place compaction: drop entries that have slid out of the window.
    let write = 0;
    for (let read = 0; read < this.timestamps.length; read++) {
      if (this.timestamps[read] >= windowStart) {
        this.timestamps[write++] = this.timestamps[read];
      }
    }
    this.timestamps.length = write;
    if (this.timestamps.length >= this.limit) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
}
