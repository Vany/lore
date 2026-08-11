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

import { isTerminal, type ReviewState } from "../core/review-state.ts";
import { spendByTier, startOfDayIso } from "./spend.ts";
import type { Store } from "../store/store.ts";

type Row = Record<string, string | number | null>;

/** One tier's attempt, open or closed. `finishedAt` null means it is running now. */
export interface BoardTierRun {
  readonly tier: string;
  readonly round: number;
  readonly outcome: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string | undefined;
}

export interface BoardReview {
  readonly id: string;
  readonly branch: string;
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
}

export interface Board {
  readonly at: string;
  readonly build: { readonly commit: string; readonly builtAt: string };
  /** A drained service looks idle from outside, and idle is the opposite fact. */
  readonly draining: boolean;
  readonly queued: number;
  readonly inFlight: number;
  readonly spendTodayUsd: number;
  /** Tiers lore has stopped asking, with whether the PROVIDER said so or lore guessed. */
  readonly tiersDown: readonly { readonly tier: string; readonly until: string; readonly why: string; readonly stated: boolean }[];
  readonly reviews: readonly BoardReview[];
}

/**
 * Terminal reviews stay on the board for two hours after they end.
 *
 * Long enough to see how the thing you were watching turned out, short enough that the
 * board is still about NOW. A board that only shows unfinished work makes a review vanish
 * at the exact moment its verdict arrives, which is when you were looking at it.
 */
const KEEP_FINISHED_MS = 2 * 3_600_000;

export function board(store: Store, now = Date.now()): Board {
  const reviews = store.boardReviews(new Date(now - KEEP_FINISHED_MS).toISOString()) as Row[];

  // Three grouped queries rather than three per review: this runs on a timer for as long
  // as a browser is open, and a per-review loop would turn one idle tab into 60 queries a
  // second against the same database the reviews are writing to.
  const ids = reviews.map((r) => String(r["id"] ?? ""));
  const runs = groupRuns(store, ids);
  const counts = groupFindings(store, ids);
  const open = groupOpen(store, ids);

  return {
    at: new Date(now).toISOString(),
    build: {
      commit: process.env["LORE_COMMIT"] ?? "unknown",
      builtAt: process.env["LORE_BUILT_AT"] ?? "unknown",
    },
    draining: store.isDraining(),
    queued: store.queueDepth(),
    inFlight: store.jobsRunning(),
    spendTodayUsd: spendByTier(store, startOfDayIso()).reduce((a, t) => a + t.usd, 0),
    tiersDown: store.unavailableTiers(new Date(now).toISOString()).map((t) => ({
      tier: t.tier,
      until: t.until,
      why: t.why,
      stated: t.stated,
    })),
    reviews: reviews.map((r) => {
      const id = String(r["id"] ?? "");
      const mine = runs.get(id) ?? [];
      const state = String(r["state"] ?? "failed") as ReviewState;
      const working = mine.find((t) => t.finishedAt === undefined);
      const ladder = parseLadder(r["ladder"]);
      const f = counts.get(id) ?? { high: 0, medium: 0, low: 0 };
      return {
        id,
        branch: String(r["branch"] ?? ""),
        into: String(r["into_ref"] ?? ""),
        type: String(r["type"] ?? ""),
        state,
        round: ladder,
        createdAt: String(r["created_at"] ?? ""),
        endedAt: isTerminal(state) ? String(r["updated_at"] ?? "") : undefined,
        movedAt: movedAt(String(r["updated_at"] ?? ""), mine, store, id),
        step: working === undefined ? undefined : working.tier,
        stepNote: stepNote(state, mine),
        tiers: mine,
        findings: { ...f, open: open.get(id) ?? 0 },
        checksSkipped: store.checksSkippedFor(id),
      };
    }),
  };
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
function stepNote(state: ReviewState, runs: readonly BoardTierRun[]): string | undefined {
  if (state !== "running") return undefined;
  if (runs.some((t) => t.finishedAt === undefined)) return undefined;
  if (runs.length === 0) return "starting — the deterministic sweep has not finished a round yet";
  return (
    "NO TIER IS WORKING — between the deterministic sweep and the next tier " +
    "(reading the diff and this repo's documents). No model call happens in this window"
  );
}
