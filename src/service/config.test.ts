/**
 * `.env` spells "unconfigured" as `LORE_WEBHOOK_URL=`, so the value arrives as an
 * empty string rather than absent — and `??` only catches `undefined`.
 *
 * Observed live: the deployment logged `alert webhook failed — Failed to parse URL
 * from ` on every disk alert, because an empty string counted as a configured
 * webhook and `fetch("")` throws. The heartbeat had it too, posting to nowhere
 * while the operator believed it was off.
 *
 * The one that matters is numeric. `Number("")` is 0, so `LORE_CONCURRENCY=` starts
 * ZERO worker loops: the service binds, answers `/status` with `ok: true`, accepts
 * reviews, queues them, and runs none of them. Healthy and doing nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "./main.ts";

const KEYS = [
  "LORE_WEBHOOK_URL", "LORE_HEARTBEAT_URL", "LORE_CONCURRENCY",
  "LORE_PORT", "LORE_DAILY_CEILING_USD", "LORE_DATA_DIR", "LORE_HOST",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("a variable set to nothing is not set", () => {
  it("never starts zero workers", () => {
    process.env["LORE_CONCURRENCY"] = "";
    expect(configFromEnv().concurrency).toBeGreaterThanOrEqual(1);
  });

  it.each([[""], ["   "]])("treats %j as an absent webhook and heartbeat", (blank) => {
    process.env["LORE_WEBHOOK_URL"] = blank;
    process.env["LORE_HEARTBEAT_URL"] = blank;
    const cfg = configFromEnv();
    expect("webhookUrl" in cfg).toBe(false);
    expect("heartbeatUrl" in cfg).toBe(false);
  });

  it("keeps a real webhook", () => {
    process.env["LORE_WEBHOOK_URL"] = "https://hooks.example/x";
    expect(configFromEnv().webhookUrl).toBe("https://hooks.example/x");
  });

  it("falls back to the defaults when blank, rather than to zero", () => {
    process.env["LORE_PORT"] = "";
    process.env["LORE_DAILY_CEILING_USD"] = "";
    const cfg = configFromEnv();
    expect(cfg.port).toBe(7777);
    expect(cfg.dailyCeilingUsd).toBeGreaterThan(0);
  });

  // Blank means "use the default" and is normal. Garbage means the deployment is
  // misconfigured, and quietly substituting a default hides it until someone
  // wonders why the ceiling never fired.
  it.each([["LORE_CONCURRENCY", "two"], ["LORE_CONCURRENCY", "0"], ["LORE_PORT", "no"]])(
    "refuses %s=%j at startup rather than guessing",
    (key, bad) => {
      process.env[key] = bad;
      expect(() => configFromEnv()).toThrow(new RegExp(key));
    },
  );
});

/**
 * A REMOVED SETTING MUST NOT BE SILENTLY IGNORED.
 *
 * `LORE_MODEL_CONCURRENCY` was the semaphore's limit until D-98 moved the bound to
 * admission. Reading it and doing nothing would leave an operator holding a knob wired to
 * nothing — believing they had tuned provider load while `LORE_CONCURRENCY`, the lever
 * that now governs it, sat untouched. This repository has been bitten twice by constants
 * that looked used and were not.
 */
describe("a setting that no longer exists", () => {
  it("refuses to start rather than ignoring LORE_MODEL_CONCURRENCY", () => {
    const before = process.env["LORE_MODEL_CONCURRENCY"];
    process.env["LORE_MODEL_CONCURRENCY"] = "4";
    try {
      expect(() => configFromEnv()).toThrow(/no longer does anything/);
      // And it names the replacement, because a refusal a reader cannot act on is a wall.
      expect(() => configFromEnv()).toThrow(/LORE_CONCURRENCY/);
    } finally {
      if (before === undefined) delete process.env["LORE_MODEL_CONCURRENCY"];
      else process.env["LORE_MODEL_CONCURRENCY"] = before;
    }
  });

  // Blank is how a .env spells "unset", and it must not be a refusal — `env()` already
  // treats an empty value as absent everywhere else for exactly this reason.
  it("treats an empty value as absent, as every other variable is", () => {
    const before = process.env["LORE_MODEL_CONCURRENCY"];
    process.env["LORE_MODEL_CONCURRENCY"] = "";
    try {
      expect(() => configFromEnv()).not.toThrow();
    } finally {
      if (before === undefined) delete process.env["LORE_MODEL_CONCURRENCY"];
      else process.env["LORE_MODEL_CONCURRENCY"] = before;
    }
  });
});
