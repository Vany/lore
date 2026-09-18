/**
 * The channel's two failure modes, and both are silent.
 *
 * Claude Code drops a channel's events with no error if the server negotiated MCP
 * revision 2026-07-28 — so getting that wrong produces a channel that runs, writes, and
 * reaches nobody. And a channel that announces the same review every tick is one the user
 * turns off, which costs them every later event too. Nothing about either shows up as a
 * crash, so they are pinned here.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decide, pollInterval, type Row } from "./lore-channel.ts";

const SERVER = fileURLToPath(new URL("./lore-channel.ts", import.meta.url));

const row = (over: Partial<Row> = {}): Row => ({
  review_id: "rev_1",
  branch: "feat/x",
  state: "findings_ready",
  waiting_on: "you",
  new_findings: 2,
  highest: "high",
  ...over,
});

describe("the handshake", () => {
  /**
   * THE ONE VALUE THAT DECIDES WHETHER ANY OF THIS WORKS. Asked for 2026-07-28 — which is
   * what a current Claude Code offers — the server must settle on something older, because
   * a channel that agrees to 2026-07-28 is silently not registered as a channel at all.
   */
  it("never settles on the revision that would make it silently unregistered", () => {
    const out = spawnSync(
      process.execPath,
      ["--experimental-strip-types", SERVER],
      {
        input: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } },
        }) + "\n",
        encoding: "utf8",
        // No token AND no `.mcp.json` to find one in, so the server announces the
        // misconfiguration and never polls — this exercises the handshake without
        // reaching the network. The empty cwd is load-bearing: the channel reads the
        // project's `.mcp.json` when no env var is set, and this repository has one with a
        // live token in it, so a test run from the repo root would quietly hit the real
        // service instead of testing what it says it tests.
        env: { ...process.env, LORE_TOKEN: "", LORE_URL: "" },
        cwd: mkdtempSync(join(tmpdir(), "lore-channel-")),
        timeout: 20_000,
      },
    );
    const first = out.stdout.split("\n").find((l) => l.includes('"id":1'));
    expect(first, `no initialize reply. stderr: ${out.stderr}`).toBeDefined();
    const reply = JSON.parse(first ?? "{}") as { result?: { protocolVersion?: string; capabilities?: Record<string, unknown> } };
    expect(reply.result?.protocolVersion).not.toBe("2026-07-28");
    // And it must still declare itself a channel — the presence of this key IS the
    // registration; without it the process is an ordinary MCP server shouting into a void.
    expect(reply.result?.capabilities?.["experimental"]).toStrictEqual({ "claude/channel": {} });
  }, 30_000);

  // A channel that cannot see anything must SAY so rather than exiting: Claude Code
  // reports nothing when a channel dies, so the user would believe they were covered.
  it("announces a missing token instead of dying quietly", () => {
    const out = spawnSync(process.execPath, ["--experimental-strip-types", SERVER], {
      input: "", encoding: "utf8",
      env: { ...process.env, LORE_TOKEN: "", LORE_URL: "" },
      cwd: mkdtempSync(join(tmpdir(), "lore-channel-")),
      timeout: 20_000,
    });
    expect(out.stdout).toContain("notifications/claude/channel");
    // NAMES BOTH PLACES IT LOOKED. "no token" sends the user hunting; "I checked these two
    // and neither had one" is a thing they can act on in one step.
    expect(out.stdout).toContain("LORE_TOKEN");
    expect(out.stdout).toContain(".mcp.json");
  }, 30_000);

  /**
   * ZERO CONFIGURATION IS THE POINT (D-148). A user running lore already has its url and
   * bearer in `.mcp.json` — that is how Claude Code reaches lore at all — so requiring
   * them again in the channel's env would be a second copy to drift, whose failure is a
   * channel quietly watching the wrong deployment while looking healthy.
   */
  it("takes the url and token from the .mcp.json it is spawned beside", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-channel-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { lore: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer tok_abc" } } },
      }),
    );
    const out = spawnSync(process.execPath, ["--experimental-strip-types", SERVER], {
      input: "", encoding: "utf8",
      // 1000, not 50: the floor refuses anything under a second now, and this test spawns
      // the real binary, so it meets the real rule. It costs nothing — `loop()` ticks once
      // BEFORE its first sleep, and the complaint under test comes from that first tick.
      env: { ...process.env, LORE_TOKEN: "", LORE_URL: "", LORE_CHANNEL_INTERVAL_MS: "1000" },
      cwd: dir,
      timeout: 15_000,
    });
    // Port 9 is the discard port: it refuses, so the channel reports the OUTAGE rather
    // than the missing token — which is only reachable if it found a token to try with.
    expect(out.stdout, "it must not report a missing token").not.toContain("found no lore token");
    expect(out.stdout).toContain("cannot reach lore at http://127.0.0.1:9/mcp");
  }, 20_000);
});

describe("decide", () => {
  it("announces a review that is waiting on the client", () => {
    const { events } = decide(new Map(), [row()], false);
    expect(events).toHaveLength(1);
    expect(events[0]?.meta["review_id"]).toBe("rev_1");
    expect(events[0]?.content).toContain("2 finding(s)");
  });

  // THE REASON THIS IS LEAVEABLE-ON. At a 15s interval an unchanged row would otherwise
  // be announced 240 times an hour, each one a turn of the session's attention.
  it("says nothing at all when nothing changed", () => {
    const { next } = decide(new Map(), [row()], false);
    expect(decide(next, [row()], false).events).toStrictEqual([]);
  });

  it("says nothing about a review lore is still working on", () => {
    const { events } = decide(new Map(), [row({ state: "running", waiting_on: "lore", new_findings: 0 })], false);
    expect(events).toStrictEqual([]);
  });

  it("speaks again when the row genuinely moves", () => {
    const { next } = decide(new Map(), [row({ new_findings: 2 })], false);
    expect(decide(next, [row({ new_findings: 5 })], false).events).toHaveLength(1);
  });

  /**
   * BACKLOG IS THE CASE THAT MATTERS MOST and it is the one a change-detector would miss:
   * a review an earlier session walked away from never "changes", so without this it would
   * sit for ever while the channel reported nothing. Measured on the live store: reviews
   * abandoned in findings_ready are the dominant way a review is wasted here.
   */
  it("marks a review that was already waiting when it started", () => {
    const { events } = decide(new Map(), [row()], true);
    expect(events[0]?.meta["backlog"]).toBe("true");
    expect(events[0]?.content).toContain("ALREADY waiting");
  });

  it("does not call it backlog once it is running", () => {
    const { events } = decide(new Map(), [row()], false);
    expect(events[0]?.meta).not.toHaveProperty("backlog");
  });

  it("reports a review that left the inbox, because that is a verdict", () => {
    const { next } = decide(new Map(), [row()], false);
    const { events } = decide(next, [], false);
    expect(events).toHaveLength(1);
    expect(events[0]?.meta["state"]).toBe("closed");
  });

  // On the FIRST look there is no previous snapshot, so nothing can have left — and
  // announcing one would be inventing an event about a session that had not started.
  it("reports no departures on its first look", () => {
    expect(decide(new Map([["rev_old", "x"]]), [], true).events).toStrictEqual([]);
  });

  it("sends a person after a needs_human review rather than a submit", () => {
    const { events } = decide(new Map(), [row({ state: "needs_human", new_findings: 0 })], false);
    expect(events[0]?.content).toContain("only a person can settle");
    expect(events[0]?.content).not.toContain("review_submit");
  });
});

/**
 * The three ways this channel could reach nobody while looking healthy.
 *
 * All three shipped in D-148 and were found by lore's own review of it: an instruction
 * whose condition the reader cannot evaluate, a row announced as actionable that no call
 * of theirs can touch, and a poll interval that parses to zero.
 */
describe("a row this token cannot act on", () => {
  const notMine = (over: Partial<Row> = {}): Row =>
    row({ not_yours_note: "started on another token of yours; only that token can drive it.", ...over });

  it("is announced, because silence would let it rot unmentioned", () => {
    const { events } = decide(new Map(), [notMine()], false);
    expect(events).toHaveLength(1);
  });

  it("never tells the agent to make a call that answers NOT FOUND", () => {
    const { events } = decide(new Map(), [notMine()], false);
    const content = events[0]?.content ?? "";
    // The whole defect: the ordinary event's instruction is "review_poll it".
    expect(content).toContain("CANNOT");
    expect(content).toMatch(/NOT FOUND/);
    expect(content).not.toMatch(/review_poll it/);
    expect(events[0]?.meta["not_yours"]).toBe("true");
  });

  it("still carries lore's own explanation rather than paraphrasing it", () => {
    const { events } = decide(new Map(), [notMine()], false);
    expect(events[0]?.content).toContain("only that token can drive it.");
  });

  it("leaves an ordinary row completely unaffected", () => {
    const { events } = decide(new Map(), [row()], false);
    expect(events[0]?.content).toContain("review_poll it");
    expect(events[0]?.meta["not_yours"]).toBeUndefined();
  });
});

describe("the poll interval refuses what it cannot read", () => {
  it("defaults when unset or blank", () => {
    expect(pollInterval(undefined)).toStrictEqual({ ms: 15_000 });
    expect(pollInterval("  ")).toStrictEqual({ ms: 15_000 });
  });

  it("takes a number of milliseconds", () => {
    expect(pollInterval("30000")).toStrictEqual({ ms: 30_000 });
  });

  /**
   * `Number("15s")` is NaN and `Number("")` is 0; `setTimeout` coerces both to ~1ms. The
   * result was a hot loop against review_inbox that looked healthy from every angle,
   * because each tick succeeded and success is what resets the complaint.
   */
  it("refuses a unit suffix rather than turning it into a hot loop", () => {
    const bad = pollInterval("15s");
    expect("bad" in bad && bad.bad).toMatch(/not a number/);
  });

  it("refuses anything under a second, whatever the operator meant by it", () => {
    expect("bad" in pollInterval("0")).toBe(true);
    expect("bad" in pollInterval("999")).toBe(true);
    expect("bad" in pollInterval("-5")).toBe(true);
  });

  /**
   * THE CEILING IS THE SAME DEFECT FROM ABOVE — found by lore's own review, fingerprint
   * c185c56a. `setTimeout` turns any delay over 2^31-1 into ONE MILLISECOND, so a value
   * typed in microseconds passes the floor and produces exactly the hot loop the floor was
   * added to make impossible, while the startup line announces a poll every 5,000,000
   * seconds.
   */
  it("refuses a value so large that setTimeout would fire immediately", () => {
    const bad = pollInterval("5000000000");
    expect("bad" in bad && bad.bad).toMatch(/24 days|1ms timer/);
    // The boundary itself is legal, so the refusal is about the coercion and not about
    // large numbers being suspicious.
    expect(pollInterval("2147483647")).toStrictEqual({ ms: 2_147_483_647 });
  });
});

/**
 * The not-yours fix, in the two places it did not reach. Both found by lore's own review of
 * it: a fix for "the channel sends the agent at calls that answer NOT FOUND" that left two
 * paths doing exactly that.
 */
describe("a not-yours row in the states the first fix missed", () => {
  const note = "started on another token of yours; only that token can drive it.";
  const humanNote = "settling it is not token-bound: knowledge_resolve works for anyone on this repository.";

  /**
   * `needs_human` is the one state where the answer is NOT "go and find the other session":
   * `knowledge_resolve` is repo-scoped, so the session reading the event can settle it. The
   * generic text said the opposite, and `needs_human` never expires on its own — so
   * following it blocks the review for ever.
   */
  it("tells a needs_human row it CAN settle the question from here", () => {
    const { events } = decide(new Map(), [row({ state: "needs_human", new_findings: 0, not_yours_note: humanNote })], false);
    expect(events).toHaveLength(1);
    const content = events[0]?.content ?? "";
    expect(content).toContain("NOT TOKEN-BOUND");
    expect(content).toContain("knowledge_resolve");
    expect(content, "the contradiction: do not send them looking for another session").not.toContain(
      "drive it from the session holding the token",
    );
    expect(content, "and it still carries lore's own words").toContain(humanNote);
  });

  it("still refuses to send an ordinary not-yours row at review_poll", () => {
    const { events } = decide(new Map(), [row({ not_yours_note: note })], false);
    expect(events[0]?.content).toContain("CANNOT");
    expect(events[0]?.content).not.toMatch(/review_poll it/);
  });

  /**
   * THE VANISH PATH. A row that leaves the inbox is announced from the previous snapshot
   * alone, which is why not-yours has to be part of the signature: without it the closing
   * event says "review_poll it once, and review_attest it if it is cleared" — the exact
   * instruction the waiting path suppresses, for the exact calls that answer NOT FOUND.
   */
  it("does not send the agent at a not-yours review when it ends", () => {
    const { next } = decide(new Map(), [row({ not_yours_note: note })], false);
    const { events } = decide(next, [], false);
    expect(events).toHaveLength(1);
    expect(events[0]?.content).not.toMatch(/review_poll it once/);
    expect(events[0]?.content).toContain("NOT FOUND");
    expect(events[0]?.meta["not_yours"]).toBe("true");
  });

  it("still tells the agent to poll a review of its OWN that ended", () => {
    const { next } = decide(new Map(), [row()], false);
    const { events } = decide(next, [], false);
    expect(events[0]?.content).toContain("review_poll it once");
    expect(events[0]?.meta["not_yours"]).toBeUndefined();
  });
});
