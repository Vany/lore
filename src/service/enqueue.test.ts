/**
 * A review the client was told is `queued` must never silently not run.
 *
 * The enqueue is fire-and-forget: `review_start` writes the row, answers
 * `state: "queued"`, and asks about budget afterwards. So everything that can go wrong
 * here goes wrong AFTER the client has been told the review exists — and nothing
 * reconciles a review with no job. `reclaimOrphanedJobs` frees jobs stuck `running`; a
 * review that never got one is invisible to it. It waits until the retention sweep calls
 * it `expired` two days later, which means *nobody came back* — the one thing that
 * definitely did not happen.
 *
 * This lived in a closure inside `serve()` with no `.catch` at all, so a throw became an
 * unhandled rejection (a dead process, by Node's default) on the way to a review nobody
 * would ever claim. It is a file now because the previous defect of exactly this shape —
 * the MCP server built with no reviewer — survived its whole life inside an untestable
 * closure.
 */

import { describe, expect, it } from "vitest";
import { Alerter, type Alert } from "../ops/alerts.ts";
import { DEFAULT_SPEND } from "../ops/spend.ts";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { enqueueOrFail } from "./enqueue.ts";

/** Captures what would have been sent, and never touches the network. */
class Recording extends Alerter {
  readonly sent: Alert[] = [];
  override async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
    return Promise.resolve();
  }
}

const seeded = (): { store: Store; id: string } => {
  const store = new Store(":memory:");
  const repo = store.upsertRepo("demo", "git@x:demo.git");
  const id = "rev_enq";
  store.createReview({
    id, repoId: repo.id, principal: "alice", branch: "feat/x", intoRef: "main",
    ticket: "t", type: "code-arch", state: "queued", ladder: initialState(),
  });
  return { store, id };
};

const alerter = () => new Recording({ timeoutMs: 100 });

describe("putting an accepted review where the worker will find it", () => {
  it("queues a job when there is budget", async () => {
    const { store, id } = seeded();
    const out = await enqueueOrFail(store, DEFAULT_SPEND, alerter(), id, "fast");
    expect(out).toBe("queued");
    expect(store.claimJob()?.reviewId, "a worker can now see it").toBe(id);
    store.close();
  });

  /**
   * THE CASE THAT USED TO END IN SILENCE.
   *
   * Anything throwing between accepting the review and enqueuing it left the review
   * `queued` for ever. `failed` is the honest end: terminal, never a pass, and the
   * client's next poll carries the reason.
   */
  it("fails the review rather than leaving it queued when the store refuses", async () => {
    const { store, id } = seeded();
    const a = alerter();
    // The store is closed under it — every statement now throws, which is the shape of
    // the mid-life corruption this service has actually seen twice.
    const broken = new Store(":memory:");
    broken.close();

    const out = await enqueueOrFail(broken, DEFAULT_SPEND, a, id, "fast");

    expect(out, "it must not reject: the caller is a fire-and-forget `void`").toBe("failed");
    // PAGES, because nothing else in the system can notice one missing job: the process
    // is alive and `/status` reads ok.
    expect(a.sent.map((x) => x.severity)).toStrictEqual(["page"]);
    expect(a.sent[0]?.condition).toBe("review accepted but not queued");
    expect(a.sent[0]?.detail).toContain(id);
    store.close();
  });

  // The review whose own store still works must be MARKED, not merely alerted about —
  // the alert reaches an operator, the state reaches the client, and the client is the
  // one waiting.
  it("marks the review failed with a reason the client can read", async () => {
    const { store, id } = seeded();
    const a = alerter();
    // Refuse only the enqueue, so the review row is still writable — this is what a
    // constraint violation or a locked table looks like, not a dead database.
    const refusing = Object.create(store) as Store & { enqueue: () => never };
    refusing.enqueue = () => {
      throw new Error("database is locked");
    };

    const out = await enqueueOrFail(refusing, DEFAULT_SPEND, a, id, "fast");

    expect(out).toBe("failed");
    expect(store.getReview(id, "alice")?.state, "terminal, so nobody waits on it").toBe("failed");
    // Not `?.` and not `?? ""`: an optional call that silently yields a default is how a
    // test comes to assert nothing at all, which is the shape of the defect above.
    expect(store.failureReason(id), "and it says why").toMatch(/could not be queued.*locked/);
    store.close();
  });

  // A ceiling that refuses must also be terminal and must say so. Silently not queueing
  // is the same defect wearing a policy.
  it("fails the review when the spend ceiling refuses it", async () => {
    const { store, id } = seeded();
    const out = await enqueueOrFail(store, { ...DEFAULT_SPEND, dailyCeilingUsd: 0 }, alerter(), id, "fast");

    expect(out).toBe("refused");
    expect(store.getReview(id, "alice")?.state).toBe("failed");
    expect(store.claimJob(), "nothing was queued").toBeUndefined();
    store.close();
  });
});
