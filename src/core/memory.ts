/**
 * Whether the machine has enough memory left to start review work on it.
 *
 * **The second door bound, and it is `core/admission.ts`'s rule applied to a resource
 * that is not lore's alone.** Vany: *"can we check docker state and do not accept review
 * starts if here is less than 1G"*, then *"just respond to reconnect in 5 minutes if here
 * is not enough memory"*. Refusing at the door beats queueing in the middle for the
 * reason D-98 already gives: a client that is refused KNOWS, and can come back, tell its
 * user, or cancel something. What is new here is WHY the door has to look outside lore at
 * all — the box is shared. lore's t0 sandboxes run beside the operator's own containers
 * (four of them were sitting `Exited (137)` on 2026-09-16), and an in-process count of
 * lore's own work cannot see one byte of that. `MemAvailable` can.
 *
 * MEASURED, THE DAY THIS WAS WRITTEN, ON THE DEPLOYMENT: one ordinary t0 sandbox running,
 * nothing wrong, 7.75 GiB of Docker VM —
 *
 *     MemFree       0.97 GiB      MemAvailable  2.40 GiB      Cached  1.44 GiB
 *
 * which is why this reads `MemAvailable` and NOT `MemFree`. Page cache counts as spent in
 * `MemFree`, so on any box that has done I/O it sits near zero for ever: a 1 GiB rule on
 * `MemFree` would have refused that review, and every review after it, on a host that was
 * working perfectly. `MemAvailable` is the kernel's own estimate of what a new allocation
 * can actually get, reclaim included, and it is the only field here that answers the
 * question being asked.
 *
 * WHAT THIS DOES NOT COVER, said plainly because the number invites the opposite reading:
 * it is an INSTANT, not a forecast. A t0 sandbox that started thirty seconds ago holds
 * 200 MB on its way to five gigabytes, and `MemAvailable` reports the 200 MB. So a burst
 * that all ramps together still overruns the box — this door stops the review that walks
 * up to a machine ALREADY short, which is a different case and not the same protection as
 * a budget that reserves what a sandbox is entitled to grow into.
 *
 * SPEC: SPEC.md D-151
 */

import { readFileSync } from "node:fs";

/** Where the kernel publishes it. Overridable only so the tests can read a fixture. */
export const MEMINFO_PATH = "/proc/meminfo";

/**
 * How long a refused client is told to wait.
 *
 * Vany's number, and a flat one on purpose. Everything else lore tells a client to wait
 * is measured from this repository's own completed rounds (`check_back_after_ms`), which
 * works because a round's length is a property of the work. Memory pressure is a property
 * of whatever else is on the box, and lore has no history of THAT to measure — a computed
 * interval here would be arithmetic dressed as evidence.
 */
export const RETRY_AFTER_MS = 5 * 60_000;

/**
 * How little may be left before lore stops accepting starts.
 *
 * 1 GiB is Vany's number. It is deliberately far below one sandbox's appetite (a rigid
 * t0 round peaks around 5 GiB) — this is not a reservation for the work about to run, it
 * is the point at which the machine is already in trouble and adding to it makes the
 * trouble harder to see. In the environment rather than a constant because it is a
 * property of the HOST, and this deployment's host memory has changed twice.
 */
// lore-ok[e8d3f8a3]: upheld, and fixed one layer out — the throw was never the gap, the
// LAZINESS was. `configFromEnv` (src/service/main.ts) now calls this at boot and logs the
// floor it found, so an unreadable value refuses to start instead of leaving the service up
// while `/status` 500s and the beat dies with no deadman POST. Covered by
// `config.test.ts`'s "refuses to start rather than accepting a LORE_MIN_AVAILABLE_MB it
// cannot read". This throw stays because it is what the boot check fires.
export function floorBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LORE_MIN_AVAILABLE_MB"];
  if (raw === undefined || raw.trim() === "") return 1024 * 1024 * 1024;
  const mb = Number(raw);
  // A bad value is a refusal to start, not a silent default: a floor nobody can see is
  // worse than no floor, and `Number("2g")` is NaN — which every comparison below would
  // answer `false` to, leaving the guard permanently open while looking configured.
  if (!Number.isFinite(mb) || mb < 0) {
    throw new Error(`LORE_MIN_AVAILABLE_MB must be a number of megabytes; got "${raw}"`);
  }
  return mb * 1024 * 1024;
}

export interface MemoryReading {
  readonly availableBytes: number;
  readonly totalBytes: number;
}

/**
 * What the guard knows — and, when it knows nothing, that it knows nothing.
 *
 * `unmeasurable` is a state of its own rather than a zero or an optimistic default,
 * because "there is plenty of memory" and "nobody can tell" are opposite facts that a
 * single number makes identical. PROG.md names this shape directly: report whether the
 * guard is CAPABLE of firing, not only whether it fired.
 */
export type MemoryState =
  | { readonly kind: "measured"; readonly reading: MemoryReading }
  | { readonly kind: "unmeasurable"; readonly why: string };

/** kB-suffixed lines: `MemAvailable:    2522140 kB`. */
function fieldBytes(meminfo: string, name: string): number | undefined {
  const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB$`, "m").exec(meminfo);
  if (m?.[1] === undefined) return undefined;
  return Number(m[1]) * 1024;
}

export function parseMeminfo(meminfo: string): MemoryState {
  const availableBytes = fieldBytes(meminfo, "MemAvailable");
  const totalBytes = fieldBytes(meminfo, "MemTotal");
  if (availableBytes === undefined || totalBytes === undefined) {
    // MemAvailable has been in Linux since 3.14, so its absence means this is not the
    // file we think it is rather than an old kernel — and guessing it from MemFree +
    // Cached is exactly the arithmetic the kernel added the field to stop people doing.
    return { kind: "unmeasurable", why: "no MemAvailable/MemTotal line in the meminfo read" };
  }
  return { kind: "measured", reading: { availableBytes, totalBytes } };
}

/**
 * Read it, or say why not.
 *
 * Never throws. lore runs in a Linux container even on a macOS host — the Docker VM's
 * `/proc/meminfo` is the VM's, which is precisely the machine the sibling sandboxes will
 * run on — but the CLI and the test suite run on the host directly, where this file does
 * not exist. That case must not take a review down: the guard is a protection, not a
 * correctness gate, and refusing every review because the protection cannot see is a
 * worse outage than the one it prevents.
 */
export function readMemory(path: string = MEMINFO_PATH): MemoryState {
  try {
    return parseMeminfo(readFileSync(path, "utf8"));
  } catch (e) {
    return { kind: "unmeasurable", why: `${path} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface MemoryVerdict {
  readonly allowed: boolean;
  /** False when the guard could not look — an `allowed` that proves nothing. */
  readonly measured: boolean;
  readonly availableBytes: number | undefined;
  readonly floorBytes: number;
  readonly retryAfterMs: number;
}

export function mayStart(state: MemoryState, floor: number): MemoryVerdict {
  if (state.kind === "unmeasurable") {
    return { allowed: true, measured: false, availableBytes: undefined, floorBytes: floor, retryAfterMs: RETRY_AFTER_MS };
  }
  const available = state.reading.availableBytes;
  return {
    allowed: available >= floor,
    measured: true,
    availableBytes: available,
    floorBytes: floor,
    retryAfterMs: RETRY_AFTER_MS,
  };
}

export function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
