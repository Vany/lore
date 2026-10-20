/**
 * THE CONTEST LEDGER (D-159): one record per rung member of every emission, every fix it
 * was shown and how its run ended, on ONE clock for the whole round — every member, every
 * route, every catch-up pass. `rule()` is the only answer to "contested or settled".
 *
 * WHY ONE LEDGER. "Who contested what this round" was computed in five or six places, each
 * from its own partial record, and each had a member state it did not see:
 *
 * - a rung whose members were ALL skipped returned before any set was built, so what they
 *   emitted before dying was never ruled on;
 * - acceptance was carried by the strongest member that COMPLETED, so with the stronger
 *   member skipped, a weaker member's silence accepted a justification for the stronger
 *   tier's finding (D-10 says the tier that asked rules on the answer);
 * - every catch-up pass kept its own clock, so a first pass's "said before the fix" released
 *   a finding that a catch-up raised again after a LATER fix, and it settled `fixed` — a
 *   verdict that never expires.
 *
 * Every one of those failed toward a wrong ACCEPT, which is the worse failure: a wrong block
 * costs a round, a wrong accept ships the defect under a signed line. So when the record
 * cannot say, the answer is UNKNOWN — never "accepted", never "fixed".
 *
 * Pure: events in, ruling out. The caller records events as they happen and persists them
 * (`contest_event`), so a ruling can be replayed from the store.
 */

/** Something a member's session was told or did, in the order it happened. */
export type ContestEvent =
  | {
      readonly kind: "emit";
      readonly seq: number;
      readonly member: string;
      readonly fingerprint: string;
      /** The route that spoke — a member's round can span a primary and a fallback. */
      readonly route: string | undefined;
    }
  | {
      /** The member's session was SHOWN a fix — at a boundary, or in a catch-up opener. */
      readonly kind: "saw-fix";
      readonly seq: number;
      readonly member: string;
    }
  | {
      /**
       * How one run of the member ended. A member can end more than once in a round (a
       * catch-up pass is another run); its LAST ending is its standing.
       *
       * `done`: declared the tree examined. `skipped`: its whole route chain failed before
       * it finished. `gave-up`: a catch-up run that did not finish — its first run's
       * reading stands, but not over the fixes it never saw.
       */
      readonly kind: "ended";
      readonly seq: number;
      readonly member: string;
      readonly how: "done" | "skipped" | "gave-up";
    };

/** Distributes `Omit` over the union, so each variant keeps its own fields. */
export type ContestEventInput = ContestEvent extends infer E ? (E extends ContestEvent ? Omit<E, "seq"> : never) : never;

/** Appends events on the round's one clock. One per round, shared by every member and pass. */
export class ContestLedger {
  private readonly log: ContestEvent[] = [];
  private seq = 0;
  /** Called after each append — the caller persists the event there. */
  private readonly onEvent: (e: ContestEvent) => void;
  constructor(onEvent: (e: ContestEvent) => void = () => {}) {
    this.onEvent = onEvent;
  }

  record(e: ContestEventInput): ContestEvent {
    const event = { ...e, seq: this.seq++ } as ContestEvent;
    this.log.push(event);
    this.onEvent(event);
    return event;
  }

  get events(): readonly ContestEvent[] {
    return this.log;
  }
}

/** What the ledger says about acceptance of one pending justification. */
export type Acceptance =
  | { readonly kind: "accepted"; readonly by: string }
  | {
      readonly kind: "unknown";
      /** Who would have had to finish, and did not — said to the client verbatim. */
      readonly why: string;
      /** Members that died this round and whose re-run could answer it. */
      readonly reask: readonly string[];
    };

export interface Ruling {
  /**
   * Fingerprints any model member emitted this round, at any time, a run that died
   * included. A re-raise after reading a justification refuses it: a contest counts even if
   * the member that made it then died.
   */
  readonly contested: ReadonlySet<string>;
  /**
   * Contested fingerprints that STILL STAND for settling a fix: some member's emission is
   * not followed by that same member being shown a fix. A finding absent from here may
   * settle `fixed` (the settle rule's other guards still apply); one in here may not.
   */
  readonly standing: ReadonlySet<string>;
  /** The member and route that last raised it, at the highest rank — whom a refusal quotes. */
  lastRaise(fingerprint: string): { readonly member: string; readonly route: string | undefined; readonly seq: number } | undefined;
  /**
   * Whether silence accepts a justification of a finding raised by a tier of rank
   * `originRank`. Only a member at that rank or above that FINISHED may carry it; anything
   * else is unknown. Not asked for contested fingerprints — those are refused.
   */
  acceptance(originRank: number): Acceptance;
}

/**
 * The single function. `rankOf` orders members by ladder position (higher is stronger);
 * `members` is every member that was in the rung this round, so a member that never
 * reached the ledger at all is still known to have been expected.
 */
export function rule(events: readonly ContestEvent[], members: readonly string[], rankOf: (member: string) => number): Ruling {
  const contested = new Set<string>();
  const lastSaw = new Map<string, number>();
  const ending = new Map<string, "done" | "skipped" | "gave-up">();
  const raises = new Map<string, { member: string; route: string | undefined; seq: number }>();
  for (const e of events) {
    if (e.kind === "saw-fix") lastSaw.set(e.member, e.seq);
    else if (e.kind === "ended") {
      // A member that finished a run keeps "done" even when a later catch-up gives up:
      // its reading of the tree stands, only not over fixes it never saw (`standing`).
      if (!(e.how === "gave-up" && ending.get(e.member) === "done")) ending.set(e.member, e.how);
    } else {
      contested.add(e.fingerprint);
      const cur = raises.get(e.fingerprint);
      // `>=`: a later raise at the same rank replaces an earlier one, so a member is quoted
      // by what it says now, not by an objection it has moved past.
      if (cur === undefined || rankOf(e.member) >= rankOf(cur.member)) {
        raises.set(e.fingerprint, { member: e.member, route: e.route, seq: e.seq });
      }
    }
  }

  // ON ONE CLOCK: an emission stands unless the SAME member was shown a fix after it. A
  // catch-up's re-raise after a later fix is later than that fix, so it stands, whatever an
  // earlier pass said before an earlier one.
  const standing = new Set<string>();
  for (const e of events) {
    if (e.kind !== "emit") continue;
    const saw = lastSaw.get(e.member);
    if (saw === undefined || saw < e.seq) standing.add(e.fingerprint);
  }

  const finished = members.filter((m) => ending.get(m) === "done");
  const died = members.filter((m) => ending.get(m) === "skipped");
  return {
    contested,
    standing,
    lastRaise: (fp) => raises.get(fp),
    acceptance: (originRank) => {
      const able = finished.filter((m) => rankOf(m) >= originRank);
      if (able.length > 0) {
        // The strongest that finished carries it: its rank is what the ruling claims.
        const by = able.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a));
        return { kind: "accepted", by };
      }
      const stronger = died.filter((m) => rankOf(m) >= originRank);
      const weaker = finished.filter((m) => rankOf(m) < originRank);
      return {
        kind: "unknown",
        why:
          (stronger.length > 0
            ? `${stronger.join(", ")} did not finish this round`
            : "no member at or above the tier that raised it ran this round") +
          (weaker.length > 0 ? `; ${weaker.join(", ")} finished, but a weaker tier's silence does not answer a stronger tier's question` : ""),
        reask: stronger,
      };
    },
  };
}
