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
  "LORE_PORT", "LORE_DAILY_CEILING_USD", "LORE_ALLOW_METERED", "LORE_DATA_DIR", "LORE_HOST",
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
    process.env["LORE_ALLOW_METERED"] = "";
    const cfg = configFromEnv();
    expect(cfg.port).toBe(7777);
    // NO IS THE DEFAULT, and it is the decision rather than a timid one: a deployment on
    // flat subscriptions has never agreed to an invoice (D-117).
    expect(cfg.allowMetered).toBe(false);
  });

  it.each([["1", true], ["true", true], ["yes", true], ["on", true], ["0", false], ["off", false]])(
    "reads LORE_ALLOW_METERED=%j as %j",
    (raw, expected) => {
      process.env["LORE_ALLOW_METERED"] = raw;
      expect(configFromEnv().allowMetered).toBe(expected);
    },
  );

  // THE ONE SETTING WHERE GUESSING SPENDS MONEY. Read as "no" it strips tiers out of
  // every review during an outage; read as "yes" it buys them. Neither may be guessed.
  it.each([["maybe"], ["2"], ["y"]])("refuses LORE_ALLOW_METERED=%j rather than guessing", (bad) => {
    process.env["LORE_ALLOW_METERED"] = bad;
    expect(() => configFromEnv()).toThrow(/LORE_ALLOW_METERED/);
  });

  // Blank means "use the default" and is normal. Garbage means the deployment is
  // misconfigured, and quietly substituting a default hides it until someone
  // wonders why a knob had no effect.
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
  it("refuses to start rather than ignoring LORE_CONCURRENCY", () => {
    const before = process.env["LORE_CONCURRENCY"];
    process.env["LORE_CONCURRENCY"] = "12";
    try {
      // There is no worker pool to size (D-101): a claimed job starts at once, and the
      // only bound is admission. An operator who sets this believes they are limiting
      // load and is not.
      expect(() => configFromEnv()).toThrow(/no longer does anything/);
      expect(() => configFromEnv()).toThrow(/admission|128/);
    } finally {
      if (before === undefined) delete process.env["LORE_CONCURRENCY"];
      else process.env["LORE_CONCURRENCY"] = before;
    }
  });

  /**
   * AND THE ONE WHOSE ABSENCE IS ABOUT MONEY (D-121).
   *
   * An operator who left `LORE_DAILY_CEILING_USD` in their `.env` believes a number caps
   * the day. None does — price is reported and never acted on — so ignoring it would let
   * somebody run a deployment they think is bounded and is not. The message names the
   * replacement, because a refusal a reader cannot act on is a wall.
   */
  it("refuses to start rather than ignoring LORE_DAILY_CEILING_USD", () => {
    const before = process.env["LORE_DAILY_CEILING_USD"];
    process.env["LORE_DAILY_CEILING_USD"] = "100";
    try {
      expect(() => configFromEnv()).toThrow(/no longer does anything/);
      expect(() => configFromEnv()).toThrow(/LORE_ALLOW_METERED/);
    } finally {
      if (before === undefined) delete process.env["LORE_DAILY_CEILING_USD"];
      else process.env["LORE_DAILY_CEILING_USD"] = before;
    }
  });

  it("refuses to start rather than ignoring LORE_MODEL_CONCURRENCY", () => {
    const before = process.env["LORE_MODEL_CONCURRENCY"];
    process.env["LORE_MODEL_CONCURRENCY"] = "4";
    try {
      expect(() => configFromEnv()).toThrow(/no longer does anything/);
      // And it names what bounds the service NOW, because a refusal a reader cannot act on
      // is a wall. It used to point at LORE_CONCURRENCY — which D-101 then deleted too, so
      // the advice would have sent an operator to a second knob that does not exist.
      expect(() => configFromEnv()).toThrow(/admission|128/);
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
