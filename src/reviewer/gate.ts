/**
 * How many model calls are in flight — counted, never queued behind.
 *
 * **A ROUND STARTS ITS SESSION IMMEDIATELY.** Vany: *"there may be no situation where a
 * job is waiting for the session in opencode — launch immediately. If you need limits,
 * okay: do not accept a request if there are already 128 reviews going."* Backpressure
 * belongs at the door, where a client is told plainly that the service is full, not in
 * the middle, where a review sits in a queue nobody can see and every clock keeps running.
 *
 * That is the shape now: admission control in `core/admission.ts` refuses a new review
 * when the service is already full, and everything admitted STARTS AT ONCE — there is no
 * worker pool either (D-101). So the number of concurrent model calls is bounded by
 * admission and by the machine, and by nothing else.
 *
 * **WHAT THIS GAVE UP, stated because the evidence is real.** This file used to hold a
 * semaphore, and it held one for a reason: on 2026-08-05 at twelve concurrent calls, four
 * reviews died within 2.5 minutes — two `socket hang up` in the same second, two empty
 * replies inside a 200 — while the host was fine. The provider was the ceiling, and it is
 * the one constraint neither the container nor the host can show. Twelve was also the
 * worker-pool size that replaced it as the effective ceiling, and D-101 removed that too.
 *
 * The trade was made deliberately: waiting is invisible and unbounded, while a provider
 * refusing is loud, lands as `this review DID NOT RUN`, and names itself. If those faults
 * return there is no concurrency knob left to turn — the levers are the tier configuration
 * and the admission limit. That is a consequence taken deliberately rather than an
 * oversight: a queue that silently absorbs the problem is what both decisions removed.
 *
 * The counter stays, because "how many calls are out right now" is the first thing an
 * operator asks and the board reports it. It just never blocks.
 */

export interface GateState {
  readonly inFlight: number;
}

export class Gate {
  private active = 0;

  state(): GateState {
    return { inFlight: this.active };
  }

  /**
   * Run `fn` now, counting it while it runs.
   *
   * Released in `finally`, so a throwing call cannot leak a count. The old semaphore had
   * the same guarantee for a sharper reason — a leaked SLOT degraded to a deadlock
   * exactly when the upstream was already failing. Here a leak would only make the
   * operator view wrong, which is still the kind of wrong this project cares about: a
   * number nobody can trust is worse than no number.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
    }
  }
}
