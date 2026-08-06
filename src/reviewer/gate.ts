/**
 * A bound on how many model calls are in flight at once, separate from how many
 * rounds are.
 *
 * **One knob governing two resources with different limits will always be wrong for
 * one of them.** `LORE_CONCURRENCY` governs both halves of a round, and they are
 * nothing alike: the model call is remote and merely waits — t1 averages 304s, t2
 * 915s — while T0 runs a sandbox container locally and is CPU- and memory-bound.
 * Raising the number buys real throughput on the waiting half and oversubscribes the
 * local one, so it was always set for T0 and the provider inherited whatever fell out.
 *
 * Measured on 2026-08-05 at `LORE_CONCURRENCY=12`: **four reviews died within 2.5
 * minutes** — two `socket hang up` in the same second, two empty replies inside a 200.
 * The host was fine. Memory held, the npm cache held. The provider was the ceiling,
 * and it is the one constraint neither the container nor the host could show. Those
 * reviews failed honestly — `this review DID NOT RUN` — but the quota was spent.
 *
 * So the local knob stays sized for cores and this one is sized for the upstream.
 * Work above the limit **queues rather than failing**, which is the same argument as
 * backpressure in `spec/mcp-api.md` §5: a review that dies on a 429 is a review that
 * did not run, so waiting is strictly better than being refused.
 *
 * Held for the WHOLE session, not per request. The load a reviewer puts on a provider
 * is its agentic exploration — an agent re-sends its accumulated context on every turn
 * (D-50), so one `review()` is one continuous demand from the first prompt to the last
 * tool call, and gating the individual HTTP calls would bound nothing.
 */

export interface GateState {
  readonly inFlight: number;
  readonly waiting: number;
  readonly limit: number;
}

export class Gate {
  private readonly limit: number;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(limit: number) {
    // Zero would deadlock every review in silence, which is the failure this project
    // refuses above all others — the same shape as `LORE_CONCURRENCY=` starting zero
    // worker loops and answering `ok: true` for ever.
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`model concurrency must be an integer >= 1, got ${limit}`);
    }
    this.limit = limit;
  }

  state(): GateState {
    return { inFlight: this.active, waiting: this.queue.length, limit: this.limit };
  }

  /**
   * Run `fn` once a slot is free.
   *
   * The slot is released in `finally`, so a throwing call cannot leak one. A gate that
   * leaks a slot per failure degrades to a deadlock exactly when the upstream is
   * already failing — the worst possible moment to stop reviewing — and it would look
   * like the provider being slow rather than like a bug here.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      // FIFO: the round that has waited longest goes next. LIFO would let a busy
      // service starve one review indefinitely while newer ones overtake it, and a
      // review nobody finishes holds a worktree and a pinned snapshot (D-70).
      this.queue.shift()?.();
    }
  }
}
