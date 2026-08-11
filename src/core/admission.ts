/**
 * How full the service may get before it stops accepting reviews.
 *
 * **The one bound that is allowed to make anybody wait, and it says so out loud.** Vany:
 * *"if you need limits, okay: do not accept a request if there are already 128 reviews
 * going."* Everything admitted then runs as soon as a worker loop reaches it — no
 * internal queue for a model slot, no round parked behind another (`reviewer/gate.ts`).
 *
 * Refusing at the door beats queueing in the middle for one reason: a client that is
 * refused KNOWS. It can come back, tell its user, or cancel something. A client whose
 * review is silently waiting sees `queued` and a clock, and cannot tell that from a
 * service that is wedged — which is the confusion that produced this rule, when three
 * jobs sat in `queued` for nineteen hours and the honest answer was that nothing would
 * ever claim them.
 *
 * SPEC: SPEC.md D-98
 */

/**
 * Reviews that may be open at once, service-wide.
 *
 * **Counted across every repository**, because the resources it protects are shared: one
 * opencode process, one host, one set of worker loops. A per-repository limit would let
 * four repositories put four times the load on the one provider that matters.
 *
 * 128 is Vany's number and it is deliberately far above normal traffic — the busiest day
 * this service has had held about a dozen open reviews. It is not a throughput knob; it
 * is the point at which something has gone wrong and accepting more would make the
 * wrongness harder to see. Nothing below it throttles: admitted work starts at once
 * (D-101), and the host is what bounds how fast it moves.
 */
export const MAX_OPEN_REVIEWS = 128;

export interface AdmissionVerdict {
  readonly allowed: boolean;
  readonly open: number;
  readonly limit: number;
}

/**
 * OPEN means not finished — every state a review can still move out of.
 *
 * Including the ones waiting on a client. A review in `findings_ready` holds a pinned
 * worktree and can become work again on the next `review_submit`, so it is occupying the
 * service whether or not anybody is currently thinking about it. Counting only what is
 * running would let a hundred abandoned reviews sit on disk while the door stayed open.
 *
 * It also puts the remedy in the client's hands, which is why the refusal names it:
 * `review_cancel` on something abandoned frees a slot immediately.
 */
export function mayAdmit(openReviews: number, limit = MAX_OPEN_REVIEWS): AdmissionVerdict {
  return { allowed: openReviews < limit, open: openReviews, limit };
}
