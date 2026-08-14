/**
 * What is happening right now, as data — the operator board's only source of facts.
 *
 * `renderStatus` answers the same question in ANSI for a terminal, and it is deliberately
 * not reused: it returns a painted string, so a second consumer would have to parse colour
 * codes back into facts. What IS shared is the reasoning, and where that reasoning is
 * subtle the comment lives in both places.
 *
 * **The question this exists to answer is "why has that been going forty minutes".** Vany
 * has asked *"what is running right now?"* four times in one week, and every time the
 * answer needed a shell into the container and three SQL queries. A review that is working
 * and a review that is wedged look identical from outside — that is the failure this whole
 * project is shaped around — so the two clocks below are the point of the thing, not
 * decoration.
 *
 * SPEC: spec/operations.md §2.4, SPEC.md D-26
 */

import { mayAdmit } from "../core/admission.ts";
import { loadavg } from "node:os";
import { fallbackRoutes, loadPools, loadTiers, routesFor } from "../core/ladder.ts";
import { isTerminal, type ReviewState } from "../core/review-state.ts";
import type { GateState } from "../reviewer/gate.ts";
import { spendByTier, startOfDayIso } from "./spend.ts";
import type { Store } from "../store/store.ts";

type Row = Record<string, string | number | null>;

/**
 * A finding, under the tier attempt that raised it.
 *
 * The full text travels. Measured on this deployment before deciding: 240 characters of
 * claim, 351 of evidence and 341 of scenario on average, and every review on an active
 * board together came to 20 KB — small enough that fetching detail on expansion would buy
 * nothing and cost a route that can fail while a person is reading.
 */
export interface BoardFinding {
  readonly fingerprint: string;
  readonly severity: string;
  readonly file: string;
  readonly line: number | undefined;
  readonly symbol: string | undefined;
  readonly claim: string;
  readonly evidence: string;
  readonly failureScenario: string;
  readonly cwe: string | undefined;
  /**
   * The branch did not cause this one (D-68) — a pattern engine matched code that was
   * already there. It sorts below the branch's own findings everywhere else for the same
   * reason it is marked here: it is not this author's work to answer.
   */
  readonly preexisting: boolean;
  /**
   * The verdict that closed it, or `undefined` while it is still work.
   *
   * Shown because a settled finding that looks identical to an open one turns a board
   * into a list of things already dealt with, and a reader who learns that stops reading.
   */
  readonly settled: string | undefined;
  readonly settledBecause: string | undefined;
}

/** One tier's attempt, open or closed. No `finishedAt` means it is running now. */
export interface BoardTierRun {
  readonly tier: string;
  readonly round: number;
  readonly outcome: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string | undefined;
  /**
   * What this attempt raised, keyed on `(origin, round)`.
   *
   * Exact rather than approximate: `finding.origin` holds the tier id and every finding
   * on this deployment matches a run on that pair — verified, zero orphans. Anything that
   * does not match still appears, on the review, under `orphanFindings`; a finding the
   * grouping cannot place must not be a finding the board does not show.
   */
  readonly findings: readonly BoardFinding[];
}

export interface BoardReview {
  readonly id: string;
  readonly branch: string;
  /**
   * The pull request, when the client named one — what the branch links to.
   *
   * Absent is ordinary: it is optional at `review_start`, and lore's own reviews run on
   * scratch refs that have none. The page renders plain text when it is missing rather
   * than a dead link.
   */
  readonly pullRequest: string | undefined;
  readonly into: string;
  readonly type: string;
  readonly state: ReviewState;
  readonly round: number;
  readonly createdAt: string;
  /**
   * When a finished review finished — absent while it is still open.
   *
   * It exists so the "time used" clock STOPS. Counting a passed review's elapsed time
   * from `createdAt` to now means the number keeps climbing days later, which says the
   * review is still consuming time and is the same lie in miniature that this board is
   * built to refuse.
   */
  readonly endedAt: string | undefined;
  /**
   * WHEN ANYTHING LAST MOVED — the browser subtracts, so the clock ticks without traffic.
   *
   * The newest of: the review's own `updated_at`, any tier run's start or finish, and any
   * finding's first sighting. All three are movement, and taking only `updated_at` would
   * call a review stalled while a tier was actively raising findings against it.
   */
  readonly movedAt: string;
  /** The tier working right now — `undefined` when none is, which is a fact in itself. */
  readonly step: string | undefined;
  /**
   * Why no tier is working, when none is.
   *
   * Copied in substance from `phaseNote`: a `running` review with no open tier row is the
   * exact shape of the stall that once cost four and a half hours, and it must not read as
   * ordinary progress. The board paints this yellow for the same reason.
   */
  readonly stepNote: string | undefined;
  readonly tiers: readonly BoardTierRun[];
  readonly findings: {
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly open: number;
  };
  /**
   * Checks that did NOT run, deduplicated across rounds (INV-1).
   *
   * On a board whose other numbers all say what happened, the absence of this line would
   * quietly claim full coverage.
   */
  readonly checksSkipped: readonly string[];
  /**
   * WHY A PERSON IS NEEDED, in full — the two statements that cannot both be true.
   *
   * Only for `needs_human`, and it is the whole content of that state. A board that
   * printed the word and not the question would be doing exactly what the MCP surface
   * did until a client said so plainly: *I cannot surface a question I was never given,
   * and guessing is what lore's own doctrine forbids.* `needs_human` is the one state
   * where nothing in the system can proceed — not a tier, not a retry, not a sweep — so
   * the reader of this page IS the mechanism, and they need the argument rather than a
   * label.
   *
   * Conflicts belong to the REPOSITORY, not the review, which is also how the inbox
   * reports them: a review is parked because its repo holds a contradiction. An empty
   * list on a parked review is therefore a real and confusing state — the question was
   * resolved and nothing re-queued the review — and the page says so rather than
   * rendering blank.
   */
  readonly openQuestions: readonly {
    readonly left: { readonly id: string; readonly statement: string; readonly source: string | undefined };
    readonly right: { readonly id: string; readonly statement: string; readonly source: string | undefined };
    /**
     * The repository the decision belongs to — the button posts it back.
     *
     * A conflict is repo-wide, not review-wide, so the thing being decided is not "this
     * review's question": it is the repository's, and settling it resumes every review
     * parked on it. Carrying the id makes that explicit rather than leaving the page to
     * infer it from whichever row happened to be open.
     */
    readonly repoId: string;
  }[];
  /** Findings whose `(origin, round)` matches no tier run. Normally empty; never hidden. */
  readonly orphanFindings: readonly BoardFinding[];
  /**
   * How many findings were left out by the per-review cap, and said out loud.
   *
   * A board that silently showed the first forty would read as a complete list. The cap
   * exists so one pathological review cannot make every push megabytes; the number exists
   * so nobody mistakes the cap for the truth.
   */
  readonly findingsNotShown: number;
}

export interface Board {
  readonly at: string;
  readonly build: { readonly commit: string; readonly builtAt: string };
  /** A drained service looks idle from outside, and idle is the opposite fact. */
  readonly draining: boolean;
  /**
   * 1/5/15-minute load average, read where lore runs — the container VM, not the Mac.
   *
   * That scoping is the honest one twice over: it is the only load visible from here,
   * and it is the load lore itself generates and suffers — t0 is CPU-bound and the
   * sandboxes burn in the same VM. Measured before adding: ~1.3µs a read, a kernel-
   * maintained value copied out, nothing like the footprint walk that once took the
   * service down from inside a health check.
   */
  readonly load: readonly number[];
  /**
   * What each route the ladder can spend is believed to cost right now (D-93).
   *
   * `queued` and `inFlight` stood here until 2026-08-13 and Vany removed them from the
   * status line: since D-98 and D-101 nothing queues and nothing pools, so both numbers
   * were near-constant zero — dead weight in the one line an operator actually reads.
   * What replaced them is the question that has mattered every day this week: WHICH
   * SUBSCRIPTION IS OUT, AND WHEN IS IT BACK.
   *
   * `until` absent means the route is believed payable — the optimistic default, absent
   * until a refusal writes otherwise. A quota PERCENTAGE is not knowable from here: no
   * provider publishes one (D-84), and inventing a number for the dashboard would be the
   * board's queued-note mistake again — a guess dressed as a reading. Hours-to-reset is
   * what lore actually knows, so it is what the board shows.
   */
  readonly providers: readonly {
    readonly route: string;
    /** When the route comes back, absent when it is believed fine. */
    readonly until?: string;
    /** True when the PROVIDER named that time; false when it is lore's doubling guess. */
    readonly stated?: boolean;
  }[];
  /**
   * How many model calls are out right now.
   *
   * No limit and nothing waiting: a round launches its session immediately (D-98), so
   * this is a measurement rather than a bound. It is the first question an operator asks
   * — is anything actually talking to a provider — and until the board existed the answer
   * needed a shell.
   *
   * Absent when this process has no reviewer, which is the CLI and the tests. A missing
   * number is not zero.
   */
  readonly modelCalls: { readonly inFlight: number } | undefined;
  /**
   * How full the service is against the point where it stops accepting reviews (D-98).
   *
   * The only queue lore has now is the one at the door, so this is the number that says
   * how close it is to shutting. Far from it in normal traffic, and that is the point:
   * reaching it means something is wrong, not that the service is busy.
   */
  readonly openReviews: { readonly open: number; readonly limit: number };
  readonly spendTodayUsd: number;
  /** Tiers lore has stopped asking, with whether the PROVIDER said so or lore guessed. */
  readonly tiersDown: readonly { readonly tier: string; readonly until: string; readonly why: string; readonly stated: boolean }[];
  readonly reviews: readonly BoardReview[];
  /**
   * Reviews the row cap left out, and said out loud.
   *
   * The ordering puts finished work last, so what gets dropped is the least interesting —
   * but that is a property of the ordering rather than a promise about the sixty-first
   * row, and the review this board exists to catch is a wedged one that nobody has
   * touched for an hour. An operator hunting a wedge must not be shown a partial list
   * that looks complete.
   */
  readonly reviewsNotShown: number;
}

/**
 * Terminal reviews stay on the board for two hours after they end.
 *
 * Long enough to see how the thing you were watching turned out, short enough that the
 * board is still about NOW. A board that only shows unfinished work makes a review vanish
 * at the exact moment its verdict arrives, which is when you were looking at it.
 */
const KEEP_FINISHED_MS = 2 * 3_600_000;

/**
 * The most findings carried for one review, worst first.
 *
 * The busiest review this deployment has produced holds 16, so this is headroom rather
 * than a limit anyone will meet — it is here so that a runaway round cannot turn every
 * two-second push into megabytes. Whatever it drops is COUNTED and reported.
 */
const MAX_FINDINGS_PER_REVIEW = 40;

export function board(store: Store, now = Date.now(), modelGate?: () => GateState): Board {
  const since = new Date(now - KEEP_FINISHED_MS).toISOString();
  const reviews = store.boardReviews(since) as Row[];

  // Three grouped queries rather than three per review: this runs on a timer for as long
  // as a browser is open, and a per-review loop would turn one idle tab into 60 queries a
  // second against the same database the reviews are writing to.
  const ids = reviews.map((r) => String(r["id"] ?? ""));
  // Read once and shared with the per-review notes: a queued review's explanation depends
  // on it, and asking twice could report a drain in the banner and not in the row.
  const draining = store.isDraining();
  /** One lookup per repository per pass, not per parked review. */
  const byRepo = new Map<string, BoardReview["openQuestions"]>();
  const runs = groupRuns(store, ids);
  const counts = groupFindings(store, ids);
  const open = groupOpen(store, ids);

  return {
    at: new Date(now).toISOString(),
    build: {
      commit: process.env["LORE_COMMIT"] ?? "unknown",
      builtAt: process.env["LORE_BUILT_AT"] ?? "unknown",
    },
    draining,
    load: loadavg(),
    providers: (() => {
      const pools = loadPools();
      const tiers = loadTiers();
      // Every concrete route the deployed ladder can reach for: primaries expanded
      // through their pools, then every fallback entry the same way. Deduped, in config
      // order, so the line reads stably instead of reshuffling per snapshot.
      const routes = [
        ...new Set([
          ...tiers.flatMap((t) => (t.kind === "model" ? routesFor(t, pools) : [])),
          ...fallbackRoutes(tiers, pools),
        ]),
      ];
      const nowIso = new Date(now).toISOString();
      return routes.map((route) => {
        const mark = store.routeUnavailable(route);
        return mark !== undefined && mark.until > nowIso
          ? { route, until: mark.until, stated: mark.stated }
          : { route };
      });
    })(),
    modelCalls: modelGate === undefined ? undefined : modelGate(),
    openReviews: (() => { const a = mayAdmit(store.openReviewCount()); return { open: a.open, limit: a.limit }; })(),
    reviewsNotShown: Math.max(0, store.boardReviewCount(since) - reviews.length),
    spendTodayUsd: spendByTier(store, startOfDayIso()).reduce((a, t) => a + t.usd, 0),
    tiersDown: store.unavailableTiers(new Date(now).toISOString()).map((t) => ({
      tier: t.tier,
      until: t.until,
      why: t.why,
      stated: t.stated,
    })),
    reviews: reviews.map((r) => {
      const id = String(r["id"] ?? "");
      const state = String(r["state"] ?? "failed") as ReviewState;
      const ladder = parseLadder(r["ladder"]);
      const f = counts.get(id) ?? { high: 0, medium: 0, low: 0 };
      const { tiers: mine, orphans, notShown } = withFindings(store, id, runs.get(id) ?? []);
      // ALL open rows, not the first: a rung runs two tiers at once (D-109), and a chip
      // naming one of them would show half of what the review is spending.
      const working = mine.filter((t) => t.finishedAt === undefined);
      return {
        id,
        branch: String(r["branch"] ?? ""),
        pullRequest: r["pull_request"] === null || r["pull_request"] === undefined
          ? undefined
          : String(r["pull_request"]),
        into: String(r["into_ref"] ?? ""),
        type: String(r["type"] ?? ""),
        state,
        round: ladder,
        createdAt: String(r["created_at"] ?? ""),
        endedAt: isTerminal(state) ? String(r["updated_at"] ?? "") : undefined,
        movedAt: movedAt(String(r["updated_at"] ?? ""), mine, store, id),
        step: working.length === 0 ? undefined : working.map((t) => t.tier).join("+"),
        stepNote: stepNote(state, mine, draining),
        tiers: mine,
        findings: { ...f, open: open.get(id) ?? 0 },
        checksSkipped: store.checksSkippedFor(id),
        // Only for the state it explains. Two queries per parked review, and a parked
        // review is rare — but they are per-repo, so a board full of them would repeat
        // the same lookup; `questionsFor` memoises on the repository for this pass.
        openQuestions: state === "needs_human" ? questionsFor(store, String(r["repo_id"] ?? ""), byRepo) : [],
        orphanFindings: orphans,
        findingsNotShown: notShown,
      };
    }),
  };
}

/**
 * Hang each finding on the tier attempt that raised it.
 *
 * `finding.origin` is the tier id and `finding.round` the round, which is exactly the
 * pair a `tier_run` row is identified by — so this is a join, not a guess. Anything that
 * fails to match comes back as an orphan rather than disappearing: the grouping is a
 * presentation choice, and a presentation choice must never decide what exists.
 */
function withFindings(
  store: Store,
  reviewId: string,
  runs: readonly BoardTierRun[],
): { tiers: BoardTierRun[]; orphans: BoardFinding[]; notShown: number } {
  const all = store.allFindings(reviewId);
  // Worst first already (`FINDING_ORDER_SQL`), so a cap keeps the ones worth seeing.
  const kept = all.slice(0, MAX_FINDINGS_PER_REVIEW);
  const openFps = new Set(store.openFindings(reviewId).map((f) => f.fingerprint));
  const verdicts = new Map<string, { verdict: string; rationale: string }>();
  for (const v of store.verdictsFor(reviewId)) {
    const fp = String(v["fingerprint"] ?? "");
    // The LAST verdict wins: `verdictsFor` is ordered by id, and a finding argued twice
    // is settled by the ruling that came second.
    verdicts.set(fp, { verdict: String(v["verdict"] ?? ""), rationale: String(v["rationale"] ?? "") });
  }

  const key = (tier: string, round: number) => `${tier}:${round}`;
  const byRun = new Map<string, BoardFinding[]>();
  const orphans: BoardFinding[] = [];
  const runKeys = new Set(runs.map((t) => key(t.tier, t.round)));

  for (const f of kept) {
    const settled = openFps.has(f.fingerprint) ? undefined : verdicts.get(f.fingerprint);
    const out: BoardFinding = {
      fingerprint: f.fingerprint,
      severity: f.severity,
      file: f.file,
      line: f.line,
      symbol: f.symbol,
      claim: f.claim,
      evidence: f.evidence,
      failureScenario: f.failureScenario,
      cwe: f.cwe,
      preexisting: f.preexisting === true,
      ...(settled === undefined ? {} : { settled: settled.verdict, settledBecause: settled.rationale }),
    } as BoardFinding;
    const k = key(f.origin, f.round);
    if (!runKeys.has(k)) {
      orphans.push(out);
      continue;
    }
    const list = byRun.get(k) ?? [];
    list.push(out);
    byRun.set(k, list);
  }

  return {
    tiers: runs.map((t) => ({ ...t, findings: byRun.get(key(t.tier, t.round)) ?? [] })),
    orphans,
    notShown: all.length - kept.length,
  };
}

/**
 * The contradictions blocking a repository, with both statements in full.
 *
 * The same shape the MCP inbox hands a client, from the same two sources — because a
 * person reading the board and an agent reading the inbox must not be told different
 * things about why the same review is stuck. A retired statement renders as `(retired)`
 * rather than vanishing: a conflict whose half has been withdrawn is exactly the case
 * where a reader needs to see that something is inconsistent.
 */
function questionsFor(
  store: Store,
  repoId: string,
  memo: Map<string, BoardReview["openQuestions"]>,
): BoardReview["openQuestions"] {
  const cached = memo.get(repoId);
  if (cached !== undefined) return cached;
  const byId = new Map(store.knowledgeFor(repoId, undefined, 1000).map((k) => [k.id, k]));
  const out = store.openConflicts(repoId).map((c) => ({
    repoId,
    left: {
      id: c.left,
      statement: byId.get(c.left)?.statement ?? "(retired)",
      source: byId.get(c.left)?.provenance,
    },
    right: {
      id: c.right,
      statement: byId.get(c.right)?.statement ?? "(retired)",
      source: byId.get(c.right)?.provenance,
    },
  }));
  memo.set(repoId, out);
  return out;
}

function parseLadder(raw: unknown): number {
  try {
    const v = JSON.parse(String(raw ?? "{}")) as { round?: number };
    return v.round ?? 0;
  } catch {
    // A ladder we cannot parse is a display problem, never a reason to blank the board.
    return 0;
  }
}

function groupRuns(store: Store, ids: readonly string[]): Map<string, BoardTierRun[]> {
  const out = new Map<string, BoardTierRun[]>();
  for (const row of store.tierRunsAcross(ids) as Row[]) {
    const id = String(row["review_id"] ?? "");
    const list = out.get(id) ?? [];
    list.push({
      tier: String(row["tier"] ?? ""),
      round: Number(row["round"] ?? 0),
      // SQLite hands back `null`, and `undefined` is what "no value" means on the wire —
      // JSON.stringify drops the key entirely, so a reader cannot mistake an open run's
      // missing finish for a finish at time zero.
      outcome: row["outcome"] === null ? undefined : String(row["outcome"]),
      startedAt: String(row["started_at"] ?? ""),
      finishedAt: row["finished_at"] === null ? undefined : String(row["finished_at"]),
      // Filled in by `withFindings`, the only place that knows findings exist.
      findings: [],
    });
    out.set(id, list);
  }
  return out;
}

function groupFindings(
  store: Store,
  ids: readonly string[],
): Map<string, { high: number; medium: number; low: number }> {
  const out = new Map<string, { high: number; medium: number; low: number }>();
  for (const row of store.findingCountsFor(ids) as Row[]) {
    const id = String(row["review_id"] ?? "");
    const bucket = out.get(id) ?? { high: 0, medium: 0, low: 0 };
    const sev = String(row["severity"] ?? "");
    if (sev === "high" || sev === "medium" || sev === "low") bucket[sev] = Number(row["c"] ?? 0);
    out.set(id, bucket);
  }
  return out;
}

/**
 * Findings still counting as work, per review.
 *
 * A settled finding is one a tier accepted an answer for, and a board that counted those
 * would show a review as having five problems when the author has answered four of them —
 * the number would go up as work was done. `store.openFindings` owns the definition; this
 * asks it once per review rather than reimplementing the join, because the join is the
 * thing that would drift.
 */
function groupOpen(store: Store, ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, store.openFindings(id).length);
  return out;
}

/**
 * The most recent evidence that anything at all happened.
 *
 * `updated_at` alone moves on STATE changes, and a tier can read a repository for twenty
 * minutes without changing state — so a board built on it would report a healthy t2 as
 * stalled from the moment its round began, and an operator who learned to ignore that
 * would have nothing left to notice a real hang with.
 */
function movedAt(updatedAt: string, runs: readonly BoardTierRun[], store: Store, id: string): string {
  let latest = updatedAt;
  for (const t of runs) {
    if (t.startedAt > latest) latest = t.startedAt;
    if (t.finishedAt !== undefined && t.finishedAt > latest) latest = t.finishedAt;
  }
  const seen = store.lastFindingAt(id) ?? "";
  return seen > latest ? seen : latest;
}

/**
 * What a review is doing when NO tier is working — the sentence that matters most here.
 *
 * A `running` review with every tier row closed is not progressing visibly, and there are
 * two entirely different reasons for that. Saying which is the difference between "wait,
 * this is normal" and "something is wedged, go and look".
 */
function stepNote(state: ReviewState, runs: readonly BoardTierRun[], draining: boolean): string | undefined {
  // WHAT `queued` IS WAITING FOR — REPORTED, NEVER GUESSED.
  //
  // This sentence has now been wrong twice, both times because it asserted a cause instead
  // of reading one. First it blamed the model-slot gate, which the same branch had deleted.
  // Then it blamed worker-loop congestion — and Vany found a review sitting queued while
  // ELEVEN OF TWELVE LOOPS WERE IDLE and the real reason, `draining`, was in the very
  // payload that rendered the row.
  //
  // A confident explanation nobody checked is the exact failure this service exists to
  // refuse, and the second one was worse than the first: an operator reading it goes
  // looking for capacity they do not need, while the flag that actually stopped their work
  // sits in the banner above. So this now branches on a fact the board HOLDS, and where it
  // holds none it says the honest thing — that being queued at all is the anomaly, since
  // D-98 means a job should be claimed within a second.
  if (state === "queued") {
    return draining
      ? "NOTHING IS BEING CLAIMED — the service is DRAINING, so no worker will pick this up. " +
        "A deploy is in progress, or a drain was left set by one that did not finish. " +
        "Until it is cleared this review will not start: `make drain-off` on the lore host"
      : "queued — no worker has claimed it yet, so NOTHING has run. This should take under a " +
        "second: nothing waits for a model slot (D-98), and the only bound is admission. " +
        "If it persists, work is not being claimed at all — check the workers rather than " +
        "assuming capacity";
  }
  if (state !== "running") return undefined;
  if (runs.some((t) => t.finishedAt === undefined)) return undefined;
  if (runs.length === 0) return "starting — the deterministic sweep has not finished a round yet";
  return (
    "NO TIER IS WORKING — between the deterministic sweep and the next tier " +
    "(reading the diff and this repo's documents). No model call happens in this window"
  );
}
