import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import type { Tier } from "../core/ladder.ts";
import type { ReviewerLike, ReviewerResult } from "../reviewer/opencode.ts";
import { bootstrap } from "./bootstrap.ts";

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store(":memory:");
  repoId = store.upsertRepo("r", "git@example.com:o/r.git").id;
});

// Found by lore's own review (8d47c789): the `known` callback `concreteRoute` uses to
// skip a quota-parked route was `() => undefined` here — unlike `screening.ts`'s
// identical call, which already passes `store.routeUnavailable`. A parked route in a
// pool could be picked here exactly as readily as a working one; the survey then
// throws on it, the worker's catch swallows the throw, and because ingest already
// left the knowledge base non-empty, the one-shot retry guard never fires again — a
// resolvable tier killed by which route got picked, permanently.
describe("bootstrap's model route respects a parked route (8d47c789)", () => {
  const tier: Tier = { id: "t1", kind: "model", model: "zai/parked-model", stage: "fast" };

  class RecordingReviewer implements ReviewerLike {
    calls: Tier[] = [];
    async review(t: Tier): Promise<ReviewerResult> {
      this.calls.push(t);
      return { findings: [] } as unknown as ReviewerResult;
    }
  }

  it("does not survey with a route it already knows is parked", async () => {
    store.markRouteUnavailable(tier.model as string, new Date(Date.now() + 60_000).toISOString(), "quota", 1, true);
    const reviewer = new RecordingReviewer();

    await bootstrap({ store, repoId, worktree: "/tmp", reviewer, tier });

    expect(reviewer.calls, "the parked route must never be handed to the reviewer").toStrictEqual([]);
  });

  it("does survey with the same route once it is no longer parked (control)", async () => {
    const reviewer = new RecordingReviewer();

    await bootstrap({ store, repoId, worktree: "/tmp", reviewer, tier });

    expect(reviewer.calls.map((t) => t.model)).toStrictEqual([tier.model]);
  });
});
