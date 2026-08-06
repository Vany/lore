/**
 * `make status` — what is happening right now, for a person.
 *
 * The operator view at `/status` answers one question ("is parallelism running or
 * silently queueing?") and answers it in JSON. It reports a review as `running` and
 * stops there, which is not enough: for hours the deployment said `running` while
 * T1 was clean, a justification had been ratified and T2 was mid-flight. Nobody
 * could see any of that without opening the database.
 *
 * For a service whose one rule is that a review which did not run must never look
 * like one that found nothing, an operator unable to see WHICH TIER IS RUNNING is
 * the thin end of exactly the ambiguity this project refuses.
 *
 * COLOUR IS LOAD-BEARING HERE, and there is one rule it must never break:
 * **`passed_partial` is not green.** It is the state most likely to be misread as a
 * pass — every tier that could run agreed, but a tier was skipped or every tier came
 * from one vendor (D-48, D-49). Green would undo in one glance what the whole
 * escalation ladder exists to say.
 *
 *   node src/ops/status.ts             every open review
 *   node src/ops/status.ts <review_id> one review, in full
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LadderState } from "../core/ladder.ts";
import { TERMINAL_SQL } from "../core/review-state.ts";
import { MAX_MIRROR_AGE_MS } from "../git/repo.ts";

// Honest in a pipe: colour is for a human at a terminal, and a log file full of
// escape codes is worse than a plain one. NO_COLOR is the convention (no-color.org).
const PLAIN = process.env["NO_COLOR"] !== undefined || !process.stdout.isTTY;
const c = (code: string) => (s: string) => (PLAIN ? s : `[${code}m${s}[0m`);

const dim = c("2");
const bold = c("1");
const red = c("1;31");
const green = c("1;32");
const yellow = c("1;33");
const blue = c("1;34");
const cyan = c("36");
const magenta = c("35");

/**
 * How each state is allowed to look.
 *
 * The mapping IS the safety property, so it lives in one place where it can be read
 * at a glance rather than being spread through the renderer:
 *
 *   green  — genuinely clean, and nothing else may borrow it
 *   yellow — real evidence, weaker than a pass, or work still in flight
 *   red    — did not finish; NEVER "found nothing"
 */
const STATE_STYLE: Readonly<Record<string, { paint: (s: string) => string; mark: string; note: string }>> = {
  passed: { paint: green, mark: "✔", note: "every tier agreed" },
  passed_partial: { paint: yellow, mark: "◑", note: "NOT a pass — a tier was skipped, or one vendor reviewed it all" },
  fast_clean: { paint: yellow, mark: "◔", note: "NOT a pass — only the cheap tiers are done" },
  findings_ready: { paint: cyan, mark: "●", note: "findings are waiting for you" },
  awaiting_diff: { paint: cyan, mark: "○", note: "waiting for your fixes" },
  needs_human: { paint: magenta, mark: "?", note: "a question you must not answer yourself" },
  running: { paint: blue, mark: "▸", note: "a tier is working" },
  queued: { paint: dim, mark: "·", note: "accepted, not started" },
  failed: { paint: red, mark: "✘", note: "DID NOT COMPLETE — not 'found nothing'" },
  expired: { paint: red, mark: "✘", note: "abandoned or timed out — not 'found nothing'" },
  stopped: { paint: red, mark: "✘", note: "hit a bound — the code it never reached is unreviewed" },
};

const SEVERITY_STYLE: Readonly<Record<string, (s: string) => string>> = {
  high: red,
  medium: yellow,
  low: dim,
};

function style(state: string): { paint: (s: string) => string; mark: string; note: string } {
  return STATE_STYLE[state] ?? { paint: bold, mark: "?", note: "unrecognised state" };
}

/** ISO strings in the database, so a plain subtraction gives NaN. */
function secondsBetween(from: unknown, to: unknown): number | undefined {
  const a = Date.parse(String(from ?? ""));
  const b = to === null || to === undefined ? Date.now() : Date.parse(String(to));
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 1000) : undefined;
}

function age(iso: unknown): string {
  const s = secondsBetween(iso, undefined);
  if (s === undefined) return "?";
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

type Row = Record<string, string | number | null>;

export function renderStatus(db: DatabaseSync, reviewId?: string, dataDir = "/var/lib/lore"): string {
  const out: string[] = [];

  const reviews = (
    reviewId === undefined
      ? db
          .prepare(
            `SELECT * FROM review
             WHERE state NOT IN (${TERMINAL_SQL})
                OR updated_at > datetime('now','-1 day')
             ORDER BY updated_at DESC LIMIT 12`,
          )
          .all()
      : db.prepare("SELECT * FROM review WHERE id = ?").all(reviewId)
  ) as Row[];

  if (reviews.length === 0) {
    // Idle still reports the mirrors: "nothing happening" and "nothing CAN happen"
    // look identical otherwise.
    return [dim("no reviews in the last day. `lore` is idle."), "", ...mirrorLines(db, dataDir)].join("\n") + "\n";
  }

  const depth = Number((db.prepare("SELECT COUNT(*) c FROM job WHERE state = 'queued'").get() as Row)["c"] ?? 0);
  const stuck = Number((db.prepare("SELECT COUNT(*) c FROM job WHERE state = 'running'").get() as Row)["c"] ?? 0);
  out.push(
    `${bold("lore")}  ${dim("queued")} ${depth}  ${dim("in flight")} ${stuck}  ${dim(new Date().toISOString().slice(11, 19))}`,
    "",
  );

  for (const r of reviews) {
    const id = String(r["id"]);
    const st = style(String(r["state"]));
    const ladder = JSON.parse(String(r["ladder"] ?? "{}")) as Partial<LadderState>;

    out.push(
      `${st.paint(`${st.mark} ${String(r["state"]).toUpperCase()}`)}  ${bold(String(r["branch"]))} ${dim("→")} ${String(r["into_ref"]).slice(0, 12)}  ${dim(id)}`,
    );
    out.push(`    ${dim(st.note)}  ${dim("·")} ${dim(`round ${ladder.round ?? 0}, updated ${age(r["updated_at"])}`)}`);

    // The tier ladder, with what actually ran. This is the line that was missing:
    // "running" alone never said which tier, and that is the whole question.
    const runs = db
      .prepare("SELECT tier, round, outcome, started_at, finished_at FROM tier_run WHERE review_id = ? ORDER BY id")
      .all(id) as Row[];
    if (runs.length > 0) {
      const cells = runs.map((t) => {
        const secs = secondsBetween(t["started_at"], t["finished_at"]);
        const took = secs === undefined ? "" : `${secs}s`;
        const label = `${t["tier"]}·r${t["round"]}`;
        const done = t["finished_at"] !== null && t["finished_at"] !== undefined;
        if (!done) return blue(`${label} ▸running ${took}`);
        const o = String(t["outcome"] ?? "");
        // A tier that COULD NOT RUN is red, not yellow, and never shares a colour
        // with one that ran and agreed. This is INV-1 at the level of a glance:
        // `unpayable` and `failed` mean code nobody looked at, and the eye must not
        // file them next to `clean`.
        //
        // `TierOutcome` is the live vocabulary — clean | findings | failed |
        // unpayable. `stopped` and `passed` are LADDER decision kinds that reached
        // this column only while `runRound` closed each row a second time; that write
        // is gone. They stay in the two lists on purpose, because rows written before
        // the fix are still in the database and a historical `stopped` must keep
        // rendering red rather than falling through to yellow. Reading them as live
        // values is what was wrong, not testing for them.
        const didNotRun = o === "unpayable" || o === "failed" || o === "stopped";
        const paint = didNotRun ? red : o === "clean" || o === "passed" ? green : o.startsWith("findings") ? cyan : yellow;
        return `${paint(`${label} ${didNotRun ? `✘ ${o}` : o}`)} ${dim(took)}`;
      });
      out.push(`    ${cells.join(dim("  →  "))}`);
    }

    // The single most important line, so it is its own line and not a colour on a
    // cell someone might not look at. `unavailable` is what D-48 records when nobody
    // could pay for a tier, and a review that reached its end with entries here is
    // "we did everything we can", never "everything agreed".
    const skipped = ladder.unavailable ?? [];
    if (skipped.length > 0) {
      out.push(`    ${red(`✘ ${skipped.length} tier(s) never ran: ${skipped.join(", ")}`)} ${dim("— that code is unreviewed")}`);
    }
    if (ladder.soleVendor !== undefined) {
      out.push(`    ${yellow(`◑ every tier that ran was ${ladder.soleVendor}`)} ${dim("— one opinion asked repeatedly, not independent reviews (D-49)")}`);
    }

    // Money and quota, per model call. On a subscription cost is $0 and the number
    // that matters is tokens, so both are shown rather than only the reassuring one.
    const usage = db
      .prepare("SELECT tier, model, input_tokens i, cached_tokens ch, output_tokens o, cost_usd cost, steps FROM usage WHERE review_id = ? ORDER BY id")
      .all(id) as Row[];
    for (const u of usage) {
      const cost = Number(u["cost"] ?? 0);
      const money = cost > 0 ? `$${cost.toFixed(4)}` : dim("$0 (subscription)");
      const steps = u["steps"] === null || u["steps"] === undefined ? dim("steps ?") : `${u["steps"]} turns`;
      out.push(
        `      ${dim("·")} ${String(u["tier"])} ${dim(String(u["model"]))}  ` +
          `${dim("in")} ${u["i"]} ${dim("cached")} ${u["ch"]} ${dim("out")} ${u["o"]}  ${steps}  ${money}`,
      );
    }

    const findings = db
      .prepare(
        `SELECT f.severity, f.file, f.line, f.fingerprint, f.claim,
                (SELECT v.verdict FROM verdict v WHERE v.review_id = f.review_id AND v.fingerprint = f.fingerprint
                 ORDER BY v.id DESC LIMIT 1) AS verdict
         FROM finding f WHERE f.review_id = ?`,
      )
      .all(id) as Row[];

    const open = findings.filter((f) => f["verdict"] === null || String(f["verdict"]).endsWith("rejected"));
    const settled = findings.length - open.length;
    if (findings.length > 0) {
      out.push(`    ${bold(`${findings.length} finding(s)`)}  ${green(`${settled} settled`)}  ${open.length > 0 ? yellow(`${open.length} open`) : dim("0 open")}`);
    }
    for (const f of open.slice(0, 8)) {
      const sev = (SEVERITY_STYLE[String(f["severity"])] ?? bold)(String(f["severity"]).padEnd(6));
      const where = `${f["file"]}${f["line"] === null ? "" : `:${f["line"]}`}`;
      out.push(`      ${sev} ${where}  ${dim(String(f["fingerprint"]).slice(0, 8))}`);
      out.push(`             ${String(f["claim"]).slice(0, 96)}`);
    }
    if (open.length > 8) out.push(dim(`      … and ${open.length - 8} more`));

    // Accepted justifications are the product, so they are shown rather than merely
    // counted: this is the codebase learning something about itself.
    const accepted = db
      .prepare(
        `SELECT fingerprint, tier, substr(rationale,1,88) why FROM verdict
         WHERE review_id = ? AND verdict = 'justified-accepted' ORDER BY id`,
      )
      .all(id) as Row[];
    for (const a of accepted) {
      out.push(`      ${green("lore-ok")} ${dim(String(a["fingerprint"]).slice(0, 8))} ${dim(`(${a["tier"]})`)} ${String(a["why"])}`);
    }

    out.push("");
  }

  out.push(...uncollectedLines(db));
  out.push(...mirrorLines(db, dataDir));

  // Repeated because a coloured tick is exactly the thing a tired reader
  // over-trusts, and these two states are the ones that cost the most when misread.
  out.push(dim("only PASSED is clean. passed_partial and fast_clean are not passes."));
  return `${out.join("\n")}\n`;
}

/**
 * Findings produced and never fetched.
 *
 * Eighteen sat unread across four reviews on 2026-08-05, fourteen of them `high`. The
 * review reached `findings_ready`, the client never polled again, and nothing said so
 * — `delivered_at` had recorded it per finding the whole time and nothing asked.
 *
 * A finding nobody reads is the same failure as a review that did not run, one step
 * later: work was done, a defect was found, and the branch is no safer for it.
 */
function uncollectedLines(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT r.branch AS branch, COUNT(*) AS n,
              SUM(CASE WHEN f.severity = 'high' AND f.preexisting = 0 THEN 1 ELSE 0 END) AS high,
              SUM(CASE WHEN f.severity = 'high' AND f.preexisting = 1 THEN 1 ELSE 0 END) AS high_pre,
              MIN(f.first_seen) AS since
       FROM finding f JOIN review r ON r.id = f.review_id
       WHERE f.delivered_at IS NULL
       GROUP BY r.id, r.branch ORDER BY since`,
    )
    .all() as Row[];
  if (rows.length === 0) return [];

  const lines: string[] = [bold("waiting to be collected"), ""];
  for (const r of rows) {
    // THE BRANCH'S OWN HIGH FINDINGS, counted apart from inherited ones (D-68).
    //
    // This counted every `high` alike and read `3 finding(s), 2 high` for a review
    // whose two high findings were both the semgrep CWE-319 hit on test fixtures the
    // branch never touches — the false positive this repository has justified over and
    // over. The one finding the branch actually caused was the `low`. So the operator
    // view raised the loudest alarm it has for the least urgent thing in the list.
    //
    // D-68 already ranks inherited pattern matches below the branch's own for the
    // CLIENT, on exactly this reasoning; the operator inherited raw severity. An alarm
    // that fires on the same known noise every day is one that gets ignored, and this
    // one is meant to say "nobody has read a real defect".
    const high = Number(r["high"] ?? 0);
    const highPre = Number(r["high_pre"] ?? 0);
    const paint = high > 0 ? red : yellow;
    const counts =
      `${r["n"]} finding(s)` +
      (high > 0 ? `, ${high} high` : "") +
      (highPre > 0 ? `, ${highPre} high preexisting` : "");
    lines.push(
      `  ${paint(counts)}  ${String(r["branch"])}  ${dim(`unread since ${age(r["since"])}`)}`,
    );
  }
  lines.push("", dim("nobody has polled these. A finding nobody reads is a review that did not run, later."), "");
  return lines;
}

/**
 * How stale each mirror is — the one thing that goes wrong in silence.
 *
 * The refresher runs OUTSIDE this service, on the host, as the operator (D-65). That
 * is the right place for it and it has one weakness: nothing in lore knows whether it
 * is still alive. A dead LaunchAgent looks exactly like a healthy one until a review
 * is refused, and on 2026-08-05 a forgotten refresh failed more reviews than every
 * model and transport fault combined.
 *
 * So the mirror's age is reported next to everything else, and crosses into red at
 * `MAX_MIRROR_AGE_MS` — the same threshold that refuses a review, rather than a
 * second number that could drift away from it. A mirror already past it is not a
 * warning about the future; it is a review that will fail if started now.
 */
function mirrorLines(db: DatabaseSync, dataDir: string): string[] {
  const repos = db.prepare("SELECT id, name FROM repo ORDER BY name").all() as Row[];
  if (repos.length === 0) return [];

  const lines: string[] = [bold("mirrors"), ""];
  for (const r of repos) {
    const bare = join(dataDir, "repos", String(r["id"]), "bare.git");
    const at = ["FETCH_HEAD", join(".git", "FETCH_HEAD")]
      .map((f) => statSync(join(bare, f), { throwIfNoEntry: false })?.mtimeMs)
      .find((m) => m !== undefined);

    if (at === undefined) {
      // Never fetched is worse than stale, not milder: `origin/<branch>` does not
      // resolve, so a base cut from it would take the frozen clone-time commit.
      lines.push(`  ${red("✗ never fetched")}  ${String(r["name"])}  ${dim("make mirror-daemon")}`);
      continue;
    }
    const ageMs = Date.now() - at;
    const shown = `${Math.round(ageMs / 60_000)}m ago`;
    lines.push(
      ageMs > MAX_MIRROR_AGE_MS
        ? `  ${red(`✗ ${shown}`)}  ${String(r["name"])}  ${dim("past the window — a review started now would be refused. make mirror-daemon-log")}`
        : `  ${green(`✓ ${shown}`)}  ${String(r["name"])}`,
    );
  }
  lines.push("");
  return lines;
}

// Guarded so the module can be IMPORTED without running.
//
// It could not be, and that is why the one part of this file with a safety property
// worth holding — the mirror-staleness warning, which is the only thing that notices
// a dead refresher — had no test. Opening a database and writing to stdout at import
// time makes a module unusable from a test, so it does not get one.
if (import.meta.main) {
  const dbPath = process.env["LORE_DATA_DIR"] ?? "/var/lib/lore";
  const db = new DatabaseSync(`${dbPath}/lore.db`, { readOnly: true });
  process.stdout.write(renderStatus(db, process.argv[2], dbPath));
  db.close();
}
