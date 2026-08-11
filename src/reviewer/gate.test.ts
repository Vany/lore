/**
 * NOTHING WAITS HERE ANY MORE — and that is the property worth testing.
 *
 * This file used to prove the opposite: a semaphore admitting N calls and queueing the
 * rest, FIFO, with a slot released on throw. The semaphore was real protection — at twelve
 * concurrent calls four reviews died in 2.5 minutes, two `socket hang up` in the same
 * second and two empty replies inside a 200 — but what it produced day to day was a round
 * sitting in `queued` with a clock running and no surface able to say whether it was
 * waiting or wedged.
 *
 * Vany: *"there may be no situation where a job waits for the session in opencode — launch
 * immediately. If you need limits, okay: do not accept a request if there are already 128
 * reviews going."* So the bound moved to the door (`core/admission.ts`, D-98), and this
 * counts what is out without ever holding anything back.
 *
 * The old tests are deleted rather than adapted: they asserted queue order and slot
 * accounting for a queue that no longer exists, and a test that still passes while
 * describing behaviour the code does not have is worse than no test.
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

describe("model calls are counted, never queued", () => {
  it("starts every call immediately, however many are already out", async () => {
    const gate = new Gate();
    const blockers = [deferred(), deferred(), deferred(), deferred(), deferred()];
    let started = 0;

    const runs = blockers.map((b) =>
      gate.run(async () => {
        started += 1;
        await b.promise;
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    // ALL of them, with none held back. Under the old semaphore this was the limit.
    expect(started, "a round must not wait for a session in opencode").toBe(5);
    expect(gate.state()).toStrictEqual({ inFlight: 5 });

    for (const b of blockers) b.resolve();
    await Promise.all(runs);
    expect(gate.state()).toStrictEqual({ inFlight: 0 });
  });

  // A count that drifts is a number an operator cannot trust, which on the one page they
  // open when something is wrong is worse than showing nothing.
  it("stops counting a call that threw", async () => {
    const gate = new Gate();
    await expect(
      gate.run(() => {
        throw new Error("provider said no");
      }),
    ).rejects.toThrow("provider said no");

    expect(gate.state()).toStrictEqual({ inFlight: 0 });
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  it("counts concurrent calls independently of each other's outcome", async () => {
    const gate = new Gate();
    const held = deferred();
    const failing = gate.run(async () => {
      await held.promise;
      throw new Error("boom");
    });
    const fine = gate.run(async () => "second ran");

    expect(gate.state().inFlight).toBe(2);
    held.resolve();
    await expect(failing).rejects.toThrow("boom");
    await expect(fine).resolves.toBe("second ran");
    expect(gate.state().inFlight).toBe(0);
  });
});
