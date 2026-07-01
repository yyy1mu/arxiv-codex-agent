// Shared rate-limit gate for the scrape task tree.
//
// arXiv enforces one channel (~1 call per 3s) across *both* search requests and
// e-print downloads. The gate serializes call-*starts*: every caller awaits
// `pass()` and is released at least `intervalMs` after the previous release,
// regardless of how long the call itself then runs. With M workers sharing one
// gate, while one worker is still streaming a slow download another can already
// claim the next 3s slot — keeping the rate-limited channel full instead of
// idling a single thread on each round-trip.
//
// Each slot adds up to `jitterMs` of random extra spacing. A perfectly even
// 1-call-per-3s cadence sits exactly on arXiv's rolling-window edge and tends to
// resonate with it; jitter breaks that lockstep (spacing becomes 3s..3s+jitter),
// trading a little throughput for far fewer 429s.
export class RateGate {
  private nextSlot = 0; // epoch ms of the next allowed call-start

  constructor(
    private readonly intervalMs: number,
    private readonly jitterMs = 0,
  ) {}

  /** Resolve once this caller owns the next slot. Slot assignment is atomic
   *  (synchronous) so concurrent callers each get a distinct, spaced slot. */
  async pass(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs + Math.random() * this.jitterMs;
    const wait = slot - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** Global backpressure: a 429/5xx from arXiv is per-IP, so make EVERY future
   *  call (search + download, all workers) wait out the cooldown — not just the
   *  one request that got throttled. Pushes the next slot to ≥ now + cooldownMs. */
  penalize(cooldownMs: number): void {
    this.nextSlot = Math.max(this.nextSlot, Date.now() + cooldownMs);
  }
}
