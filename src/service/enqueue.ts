/**
 * The gap between accepting a review and it being claimable, and what happens if it fails.
 *
 * `review_start` writes the review row, answers the client `state: "queued"`, and only
 * then asks whether there is budget to run it. That last step is fire-and-forget by
 * design — a spend check that blocked the reply would make every `review_start` wait on
 * two table scans and possibly a webhook — which means it is also the one place a review
 * can be **accepted and then quietly never happen**.
 *
 * Nothing reconciles that. `reclaimOrphanedJobs` frees jobs stuck `running`; a review
 * with no job at all is invisible to it, so it sits `queued` while its client polls a
 * thing no worker can see, until the retention sweep calls it `expired` two days later —
 * and `expired` means *nobody came back*, which is the one thing that definitely did not
 * happen. Before this file the failure also went to an unhandled rejection, which Node
 * turns into a dead process by default.
 *
 * So the rule here is the project's rule, applied to a queue: a review that cannot start
 * ends as `failed`, now, with the reason attached. `failed` is terminal, is never a pass,
 * and the client's next poll says so.
 *
 * Extracted from `main.ts` because a closure built inside `serve()` cannot be tested, and
 * the untestable closure is exactly where the last defect of this shape lived — the MCP
 * server was handed no reviewer for the whole of its life and every test built it the
 * same way, so the broken path was the only path under test.
 *
 * SPEC: spec/mcp-api.md §3, spec/operations.md §2
 */

import { Alerter, CONDITIONS } from "../ops/alerts.ts";
import { mayStart, type SpendConfig } from "../ops/spend.ts";
import type { Store } from "../store/store.ts";

/**
 * Decide whether this review may run, and put it where the worker will find it.
 *
 * Returns rather than throws: every caller is a fire-and-forget `void`, and a rejection
 * from here has nowhere to go but the process's unhandled-rejection handler.
 */
export async function enqueueOrFail(
  store: Store,
  spend: SpendConfig,
  alerter: Alerter,
  reviewId: string,
  stage: "fast" | "deep",
): Promise<"queued" | "refused" | "failed"> {
  try {
    // Checked before starting, never mid-review: killing a review halfway leaves it
    // neither passed nor honestly failed, and wastes what was already spent.
    const verdict = await mayStart(store, spend, alerter);
    if (!verdict.allowed) {
      store.updateReview(reviewId, { state: "failed" });
      store.setFailureReason(
        reviewId,
        `not started: today's spend ${verdict.spent.toFixed(2)} has reached the ${verdict.ceiling.toFixed(2)} ceiling`,
      );
      return "refused";
    }
    store.enqueue(reviewId, stage);
    return "queued";
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // STATE FIRST, reason second, and the reason is allowed to be the part that fails.
    // The state is what a client reads and what makes the review terminal; a missing
    // explanation is worse service, a review stuck `queued` for ever is a broken one.
    try {
      store.updateReview(reviewId, { state: "failed" });
      store.setFailureReason(reviewId, `could not be queued: ${why}`);
    } catch {
      // If even this will not write, the alert below is the only record there is —
      // which is the case the alerter exists for. Swallowed deliberately: throwing here
      // would replace a diagnosable fault with the cleanup's.
    }
    await alerter.send(CONDITIONS.reviewNotQueued(reviewId, stage, why));
    return "failed";
  }
}
