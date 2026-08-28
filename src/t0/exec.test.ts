/**
 * Running the target repo's tooling — specifically, what a REAL signal death
 * reports, as opposed to a script that merely exits with a number that looks
 * like one.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTool } from "./exec.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-exec-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Fingerprint 88fccc85/fdf8a29e/1b65dcdd, found by lore's own review of the
 * OOM-kill fix: Node reports a process a SIGNAL killed with `err.code` as the
 * signal's NAME (or null/undefined), never a number — so `typeof err.code ===
 * "number"` was always false for a genuine SIGKILL, and every `code === 137`
 * check downstream (t0/engines.ts's semgrep/ast-grep, both fixed in an earlier
 * round of this same incident) was testing a value that could never occur for
 * the exact scenario its own comment names: an OOM-killer signalling a host
 * binary directly. `docker run` does not have this problem — it translates a
 * killed CONTAINER into its own ordinary exit code — which is why runner.ts's
 * equivalent checks were already correct and needed no change here.
 *
 * A script that EXITS 137 (every earlier test in this repo's own T0 suite)
 * is a different event entirely: a normal, voluntary exit that happens to
 * carry that number. This one signals itself, which is what `execFile`
 * actually reports for a real kill, and what those tests' fakes could not
 * exercise.
 */
describe("a process a signal killed reports the POSIX exit code, not the raw signal", () => {
  it("translates a self-inflicted SIGKILL to 137", async () => {
    const script = join(dir, "self-kill.sh");
    writeFileSync(script, "#!/bin/sh\nkill -9 $$\n");
    chmodSync(script, 0o755);

    const out = await runTool(dir, script, []);
    expect(out.ok).toBe(false);
    expect(out.code, "128 + SIGKILL's signal number (9)").toBe(137);
    expect(out.timedOut, "signalled directly, not by execFile's own timeout timer").toBe(false);
  });

  it("still reports an ordinary non-zero exit as itself, untranslated", async () => {
    const script = join(dir, "exit-one.sh");
    writeFileSync(script, "#!/bin/sh\nexit 1\n");
    chmodSync(script, 0o755);

    const out = await runTool(dir, script, []);
    expect(out.ok).toBe(false);
    expect(out.code).toBe(1);
  });
});

// Fingerprint 72871cca: semgrep, ast-grep and cdxgen all run here on a reviewed
// repository's own untrusted content — a comment claiming "no ambient
// credentials" while spreading `process.env` verbatim was the opposite of true.
describe("a tool run against untrusted content inherits no ambient credential", () => {
  const echoEnv = (name: string): string => {
    const script = join(dir, "echo-env.sh");
    writeFileSync(script, `#!/bin/sh\nprintenv ${name}\n`);
    chmodSync(script, 0o755);
    return script;
  };

  it("does not see a var set only in this process's own environment, by default", async () => {
    process.env["LORE_TEST_SECRET"] = "top-secret";
    try {
      const out = await runTool(dir, echoEnv("LORE_TEST_SECRET"), []);
      expect(out.stdout.trim()).toBe("");
    } finally {
      delete process.env["LORE_TEST_SECRET"];
    }
  });

  it("still sees PATH, so a bare command name keeps resolving", async () => {
    const out = await runTool(dir, echoEnv("PATH"), []);
    expect(out.stdout.trim()).not.toBe("");
  });

  it("sees the full environment only when a caller explicitly opts in (docker itself, not the reviewed content)", async () => {
    process.env["LORE_TEST_SECRET"] = "top-secret";
    try {
      const out = await runTool(dir, echoEnv("LORE_TEST_SECRET"), [], 300_000, true);
      expect(out.stdout.trim()).toBe("top-secret");
    } finally {
      delete process.env["LORE_TEST_SECRET"];
    }
  });
});
