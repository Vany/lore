/**
 * The npm cache is keyed by LOCKFILE HASH, so every branch of a repository that has
 * not changed its lockfile shares one `node_modules`, mounted read-write into each
 * sandbox. Concurrent reviews of one repo therefore install into the same directory
 * at the same time.
 *
 * The failure is not a crash: a half-written `node_modules` makes `tsc` and `eslint`
 * report errors that are not real — the service breaking the target's gates and then
 * reporting them as broken.
 */

import { describe, expect, it } from "vitest";
import { withInstallLock } from "./runner.ts";

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("installs sharing a cache directory run one at a time", () => {
  it("never lets two overlap", async () => {
    let active = 0;
    let peak = 0;
    const install = async () => {
      active++;
      peak = Math.max(peak, active);
      await settle();
      active--;
    };

    await Promise.all(Array.from({ length: 8 }, () => withInstallLock("/cache/abc", install)));
    expect(peak).toBe(1);
  });

  // Different lockfiles are different trees; serialising those would be throughput
  // thrown away for a race that cannot happen.
  it("does not serialise unrelated caches", async () => {
    let active = 0;
    let peak = 0;
    const install = async () => {
      active++;
      peak = Math.max(peak, active);
      await settle();
      active--;
    };

    await Promise.all([
      withInstallLock("/cache/a", install),
      withInstallLock("/cache/b", install),
      withInstallLock("/cache/c", install),
    ]);
    expect(peak).toBe(3);
  });

  // A failed install must not wedge every later review of that repository behind it.
  it("keeps running after one fails, and reports the failure to its own caller", async () => {
    const boom = withInstallLock("/cache/x", () => Promise.reject(new Error("install died")));
    await expect(boom).rejects.toThrow("install died");

    await expect(withInstallLock("/cache/x", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("returns each caller its own result, in order", async () => {
    const out: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        withInstallLock("/cache/ordered", async () => {
          await settle();
          out.push(n);
          return n;
        }),
      ),
    );
    expect(out).toStrictEqual([1, 2, 3]);
  });
});
