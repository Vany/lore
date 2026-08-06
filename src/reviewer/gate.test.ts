/**
 * The bound that was missing when four reviews died in 2.5 minutes.
 *
 * `LORE_CONCURRENCY=12` oversubscribed the PROVIDER, not the host: memory held, the
 * npm cache held, and the upstream refused the load with two `socket hang up` in the
 * same second and two empty replies inside a 200. The reviews failed honestly — *this
 * review DID NOT RUN* — but the quota was spent.
 */

import { describe, expect, it } from "vitest";
import { Gate } from "./gate.ts";

/** A promise with its resolver, so a test can hold calls open deliberately. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Gate", () => {
  it("runs up to the limit at once and makes the rest wait", async () => {
    const gate = new Gate(2);
    const blockers = [deferred(), deferred(), deferred()];
    let started = 0;

    const runs = blockers.map((b) =>
      gate.run(async () => {
        started += 1;
        await b.promise;
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(2);
    expect(gate.state()).toMatchObject({ inFlight: 2, waiting: 1 });

    blockers[0]?.resolve();
    await runs[0];
    await Promise.resolve();
    expect(started).toBe(3);

    blockers[1]?.resolve();
    blockers[2]?.resolve();
    await Promise.all(runs);
    expect(gate.state()).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  // THE ONE THAT MATTERS. A gate that leaks a slot per failure degrades to a deadlock
  // exactly when the upstream is already failing — the worst possible moment to stop
  // reviewing — and from outside it would look like the provider being slow.
  it("releases the slot when the call throws", async () => {
    const gate = new Gate(1);
    await expect(
      gate.run(() => {
        throw new Error("provider said no");
      }),
    ).rejects.toThrow("provider said no");

    expect(gate.state()).toMatchObject({ inFlight: 0, waiting: 0 });
    // Still usable, which is the actual claim.
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  it("lets a waiter through after the holder throws", async () => {
    const gate = new Gate(1);
    const held = deferred();
    const first = gate.run(async () => {
      await held.promise;
      throw new Error("boom");
    });
    const second = gate.run(async () => "second ran");

    held.resolve();
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("second ran");
  });

  // FIFO, because LIFO lets a busy service starve one review indefinitely — and a
  // review nobody finishes holds a worktree and a pinned snapshot (D-70).
  it("admits waiters in the order they arrived", async () => {
    const gate = new Gate(1);
    const held = deferred();
    const order: number[] = [];

    const first = gate.run(async () => {
      await held.promise;
    });
    const rest = [1, 2, 3].map((n) =>
      gate.run(async () => {
        order.push(n);
      }),
    );

    held.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toStrictEqual([1, 2, 3]);
  });

  // Zero would deadlock every review in silence — the same shape as LORE_CONCURRENCY=
  // starting zero worker loops while answering ok: true for ever.
  it("refuses a limit that would stop all work", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new Gate(bad)).toThrow(/>= 1/);
    }
  });
});
