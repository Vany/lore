/**
 * The gap between accepting a review and it being claimable, and what happens if it fails.
 *
 * `review_start` writes the review row, answers the client `state: "queued"`, and only
 * then puts it on the queue. That last step is fire-and-forget by design, which means it
 * is also the one place a review can be **accepted and then quietly never happen**.
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
import type { Store } from "../store/store.ts";

/**
 * Put this review where the worker will find it.
 *
 * Returns rather than throws: every caller is a fire-and-forget `void`, and a rejection
 * from here has nowhere to go but the process's unhandled-rejection handler.
 *
 * NOTHING IS REFUSED HERE ANY MORE (D-121). This used to ask a daily spend ceiling for
 * permission and write `failed` on the review when the answer was no — the string
 * `not started: today's spend 101.36 has reached the 100.00 ceiling`, which on 2026-08-16
 * eight of other people's reviews carried into their clients as a failure. Money is not
 * a reason to refuse somebody's review; what a metered route may do is settled before the
 * call instead (D-117), and a review that is admitted is a review that will run.
 */
export async function enqueueOrFail(
  store: Store,
  alerter: Alerter,
  reviewId: string,
  stage: "fast" | "deep",
): Promise<"queued" | "failed"> {
  try {
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
