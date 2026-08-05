/**
 * The MCP surface.
 *
 * A server instance is built **per authenticated principal**, so the principal is
 * baked in rather than passed around and remembered. Possession of a `review_id`
 * is never authentication (D-23), and the cheapest way to guarantee that is to
 * make it impossible to ask for a review without saying who you are.
 *
 * SPEC: spec/mcp-api.md
 */

import { randomBytes } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import { absent } from "../core/optional.ts";
import { worstSeverity } from "../core/finding.ts";
import { initialState } from "../core/ladder.ts";
import { isAttestable } from "../core/review-state.ts";
import { DEFAULT_TYPE, reviewType, reviewTypeIds } from "../core/review-type.ts";
import { applyPatch, treeHash } from "../git/repo.ts";
import { enrich, renderEnrichment } from "../knowledge/enrich.ts";
import { buildVex, findingsNeedingTriage, renderVex } from "../security/vex.ts";
import { FINDING_ORDER_SQL } from "../store/schema.ts";
import { isSettled, type Store } from "../store/store.ts";
import type { Principal } from "./auth.ts";
import { REVIEW_PROMPT_TEXT, RESOURCE_DOCS, TOOL_DOCS } from "./docs.ts";

export interface ServerDeps {
  readonly store: Store;
  /** Worktree for a review, once one exists. */
  readonly worktreeFor: (reviewId: string) => Promise<string>;
  /** Queue the review for the background workers. */
  readonly enqueue: (reviewId: string, stage: "fast" | "deep") => void;
  readonly attest: (reviewId: string) => Promise<string>;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/**
 * CSPRNG, never sequential.
 *
 * The moment ids are guessable, every log line containing one becomes a credential
 * (D-23).
 */
function newReviewId(): string {
  return `rev_${randomBytes(18).toString("base64url")}`;
}

export function buildServer(who: Principal, deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "lore", version: "0.1.0" });
  const { store } = deps;

  /** Fetch a review or refuse. A valid id from another principal fails like a forged one. */
  const mine = (reviewId: string) => {
    const r = store.getReview(reviewId, who.principal);
    if (r === undefined) throw new Error(`review ${reviewId} not found`);
    return r;
  };

  // ------------------------------------------------------------ review.start

  server.registerTool(
    "review_start",
    {
      description: TOOL_DOCS.start,
      inputSchema: z.object({
        branch: z.string().min(1).describe("branch under review"),
        into: z.string().min(1).describe("branch it will merge into"),
        ticket: z
          .string()
          .min(1)
          .describe("the task text, pasted verbatim — not summarised, not your own description"),
        type: absent(z.enum(reviewTypeIds() as [string, ...string[]])).describe(`default: ${DEFAULT_TYPE}`),
        restart: absent(z.boolean()).describe(
          "abandon an open review of this branch and start over — only after a rebase or force-push",
        ),
      }),
    },
    async ({ branch, into, ticket, type, restart }) => {
      // AN OPEN REVIEW OF THIS BRANCH IS THE ONE TO CONTINUE, NOT TO DUPLICATE.
      //
      // Measured 2026-08-05, the first day a real client drove this: six reviews of
      // one branch in two hours, four of another, and 13 of 30 reviews stopping at
      // round 1. The ladder needs round 2 to settle anything — carry findings
      // forward, escalate, ratify a justification — so a repository being reviewed
      // all day produced ZERO verdicts and learned nothing. Every restart also
      // re-pays t0 and t1 from scratch.
      //
      // Nothing told the client that `review_submit` continues the same review, and
      // nothing noticed it was starting a fifth one. The docs say it now, and this
      // is the mechanical half: refused, with the id to continue instead. A refusal
      // rather than silently returning the existing review, because "here is a
      // review_id" that is not the one just asked for is exactly the kind of quiet
      // substitution this project refuses.
      const open = store.openReviewFor(who.repoId, branch);
      if (open !== undefined && restart !== true) {
        throw new Error(
          `${branch} already has an open review: ${open.id} (state ${open.state}, round ${open.round}). ` +
            `Continue it — poll it, then answer its findings with review_submit, which applies your fixes ` +
            `to the SAME review and advances the ladder. Starting again would re-run the cheap tiers from ` +
            `round 1 and abandon every justification this review has already ratified, which is why the ` +
            `deep tiers are rarely reached. If the branch was rebased or force-pushed the old snapshot is ` +
            `genuinely meaningless — pass restart: true, deliberately.`,
        );
      }

      const rt = reviewType(type ?? DEFAULT_TYPE);
      const id = newReviewId();
      store.createReview({
        id,
        repoId: who.repoId,
        principal: who.principal,
        branch,
        intoRef: into,
        ticket,
        type: rt.id,
        state: "queued",
        ladder: initialState(rt.tiers),
      });
      // Fast stage first: at 30 PRs a day nobody waits for a full ladder (D-34).
      deps.enqueue(id, "fast");
      return text(
        JSON.stringify({
          review_id: id,
          state: "queued",
          note: "Started. This does NOT mean it finished — poll until a terminal state.",
        }),
      );
    },
  );

  // ------------------------------------------------------------- review.poll

  server.registerTool(
    "review_poll",
    {
      description: TOOL_DOCS.poll,
      inputSchema: z.object({ review_id: z.string().min(1) }),
    },
    async ({ review_id }) => {
      const review = mine(review_id);
      const fresh = store.undelivered(review_id);
      store.markDelivered(review_id, fresh.map((f) => f.fingerprint));

      return text(
        JSON.stringify({
          review_id,
          state: review.state,
          // Restated on every poll, because failure mode 1 and 7 are the two most
          // likely ways this loop ends with unreviewed code shipped.
          clean: review.state === "passed",
          note:
            review.state === "passed"
              ? "Every tier agrees. You may attest and merge."
              : "NOT clean. Only `passed` means clean.",
          new_findings: fresh.map((f) => {
            const short = f.fingerprint.slice(0, 8);
            // A finding can be raised and settled inside one round: D-51 carries a
            // justification this repo already ratified into a later review and
            // accepts it without anyone answering. It is still NEW to this caller,
            // so it is still delivered — but telling them to justify it would be a
            // confident instruction to do work that is already done, and the lore-ok
            // they wrote in response would be fresh surface for the next tier to
            // review. Observed here: a semgrep CWE-319 on a loopback test server,
            // auto-settled by carry-forward, handed back with `justify_with` set.
            // The question is whether the finding is CLOSED, not whether a verdict
            // row exists. `justified-rejected` is a verdict and leaves the finding
            // open — the reviewer read the reason and refused it — so asking the
            // wrong one labelled the most serious case "nothing to do" while
            // `open_count` still counted it (t2, medium).
            const verdict = store.latestVerdict(review_id, f.fingerprint);
            const closed = verdict !== undefined && isSettled(verdict.verdict);
            const rejected = verdict?.verdict === "justified-rejected";
            return {
              fingerprint: short,
              file: f.file,
              line: f.line,
              symbol: f.symbol,
              severity: f.severity,
              cwe: f.cwe,
              claim: f.claim,
              evidence: f.evidence,
              failure_scenario: f.failureScenario,
              ...(closed
                ? {
                    settled: verdict.verdict,
                    settled_because: verdict.rationale ?? "no reason recorded",
                    note: "Already settled — nothing to do. Shown because it is new to you.",
                  }
                : {
                    justify_with: `// lore-ok[${short}]: <why this code is correct>`,
                    // Still open, and worse than open: a justification was offered
                    // and refused. Saying so is the difference between "answer this"
                    // and "your answer was wrong".
                    ...(rejected
                      ? {
                          justification_rejected: verdict.rationale ?? "no reason recorded",
                          note: "Your justification was REJECTED. Fix the code, or give a reason that holds.",
                        }
                      : {}),
                  }),
              // A finding with history is far more actionable than the same finding
              // raised cold: it says whether to fix the line or fix the habit.
              history: renderEnrichment(enrich(store, who.repoId, f)),
            };
          }),
          open_count: store.openFindings(review_id).length,
          // Deterministic, known in milliseconds, and the fact a landing decision
          // actually turns on. It was reaching the reviewer's prompt and stopping
          // there, so a client triaging eight open pull requests would have needed
          // eight model-tier reviews to learn which ones were stale.
          ...(() => {
            const n = store.behindBy(review_id);
            return n === undefined || n === 0
              ? {}
              : {
                  behind_by: n,
                  behind_by_note:
                    `The base has ${n} commit(s) this branch does not. The findings above are correct for the ` +
                    "fork point, but nothing here was checked against the base as it now stands — so a `passed` " +
                    "does not mean this merges cleanly or still works. Rebase and review again before landing.",
                };
          })(),
          // WHY it did not run, not merely that it did not. A bare `failed` is the
          // shape INV-1 refuses: indistinguishable from "found nothing" to anyone
          // who has to act on it, and an invitation to guess. A client given only
          // the word published a diagnosis that was the opposite of the truth.
          ...(() => {
            if (!["failed", "expired"].includes(review.state)) return {};
            const why = store.failureReason(review_id);
            return why === undefined
              ? {
                  failed_because:
                    "no reason was recorded, which is itself a defect — report it rather than inferring a cause",
                }
              : { failed_because: why };
          })(),
          // A check that did not run is not a check that found nothing (INV-1). The
          // deterministic engines are the ones that go missing silently — no
          // `node_modules`, no test script, a disabled suite — and their absence
          // narrows what any later `passed` is evidence OF. The model tiers are told
          // in their prompt; the client has no other way to find out.
          ...(() => {
            const skipped = store.unavailableChecks(review_id);
            return skipped.length === 0
              ? {}
              : {
                  checks_skipped: skipped,
                  checks_skipped_note:
                    "These checks did NOT run. Anything they would have caught is unexamined — " +
                    "say so to your user, and weigh a later `passed` accordingly.",
                };
          })(),
          // THE QUESTION ITSELF, not just the fact that there is one.
          //
          // `needs_human` is the single state whose entire purpose is "a person must
          // decide this" — and it shipped saying only that. A client hit it on a real
          // review and reported, correctly, that lore "does not say which question".
          // Telling an agent to stop and ask a human, without telling it what to ask,
          // is the same defect as a review that did not run reporting nothing found:
          // the machine knows something the caller needs and does not say it.
          //
          // Rendered rather than raw ids: the two statements ARE the question, and an
          // id pair sends the reader on a second lookup for the only thing that
          // matters.
          ...(() => {
            if (review.state !== "needs_human") return {};
            const open = store.openConflicts(review.repoId);
            const byId = new Map(store.knowledgeFor(review.repoId, undefined, 1000).map((k) => [k.id, k]));
            const questions = open.map((c) => ({
              left: { id: c.left, statement: byId.get(c.left)?.statement ?? "(retired)", source: byId.get(c.left)?.provenance },
              right: { id: c.right, statement: byId.get(c.right)?.statement ?? "(retired)", source: byId.get(c.right)?.provenance },
            }));
            if (questions.length > 0) {
              return {
                needs_human_because:
                  "This repository's memory contains statements that cannot both be true. A REVIEW CANNOT SETTLE THIS — " +
                  "the answer decides what every future session is told about this codebase, so a person must choose. " +
                  "Take it to them, then call knowledge_resolve with the id to keep, or knowledge_escalate if they cannot decide either.",
                open_questions: questions,
              };
            }
            // ANSWERED. The state is a record of where the review stopped, not a
            // claim that it is still stopped — and the way out is a submit, which is
            // the same way out as every other round.
            //
            // Written the wrong way round first, and caught while a real review was
            // sitting in exactly this position: with no open conflicts left, this
            // said the record was "gone" and told the client to report a defect in
            // lore. Resolution is the NORMAL exit from needs_human, not evidence of
            // data loss, and sending a client to raise a bug because a person did
            // what they were asked to do is its own small betrayal of INV-1.
            return {
              needs_human_because:
                "The question has been ANSWERED — no contradiction is open any more. Nothing is blocking this " +
                "review: call review_submit with your work (an empty diff is fine if there is nothing to change) " +
                "and the ladder continues from where it stopped.",
              open_questions: [],
            };
          })(),
        }),
      );
    },
  );

  // ----------------------------------------------------------- review.submit

  server.registerTool(
    "review_submit",
    {
      description: TOOL_DOCS.submit,
      inputSchema: z.object({
        review_id: z.string().min(1),
        diff: z.string().min(1).describe("unified diff of your fixes"),
        tree_hash: z
          .string()
          .min(1)
          .describe("git write-tree of your working tree after applying — verified after we apply"),
      }),
    },
    async ({ review_id, diff, tree_hash }) => {
      mine(review_id);

      // The worktree is resolved FIRST so the only `await` before the check is
      // behind us; the check and the write then sit together with nothing to yield
      // between them.
      const worktree = await deps.worktreeFor(review_id);

      // REFUSED while a round is pending, because the next line writes into the
      // directory that round reads (D-55).
      //
      // D-53 stopped two rounds running at once. It did not stop a writer from
      // OUTSIDE the queue, and this is one: a tier computes its diff, starts
      // exploring, and a submit rewrites the files under it. Its prompt and its
      // tier_run row describe the old tree while its tools read a new or
      // half-patched one, and a `clean` from that describes a tree that has never
      // existed anywhere — which is the failure the tree-hash check below exists to
      // prevent, arriving from the other side (D-40). Raised by t3 as 5bb4272e
      // against the very change that serialised the rounds.
      //
      // Refusing rather than queueing the patch: the client already polls (D-34),
      // the fix genuinely cannot be reviewed until the current round is done, and
      // storing pending patches would add a second place where a review's tree
      // lives. The error says what to wait for.
      // The wait condition is stated POSITIVELY, as the states that accept a diff.
      //
      // Naming the states to wait past instead — "until it is not running or queued"
      // — described the JOB while the client can only see the REVIEW, and the two
      // disagree exactly where it matters: during `fast_clean` the deep round is
      // already queued, so the submit is refused while the client's exit condition
      // reads as met. It would poll, see `fast_clean`, submit, and be refused again,
      // for ever, with no state named that it could actually wait for (df1fc19c).
      if (store.hasPendingRound(review_id)) {
        throw new Error(
          `a review round is pending for ${review_id}; a reviewer is reading — or is about to read — the ` +
            `worktree this patch would rewrite. Call review_poll until the state is 'findings_ready' or ` +
            `'awaiting_diff' — those are the states that accept a diff — then submit the same diff again. ` +
            `Note that 'fast_clean' is NOT one of them: the deep tiers are still queued against this worktree. ` +
            `Nothing was applied.`,
        );
      }

      await applyPatch(worktree, diff);

      const applied = await treeHash(worktree);
      if (applied !== tree_hash) {
        // Without this check a fuzzy or partial apply leaves us reviewing a tree
        // that exists nowhere — not in git, not on the client's disk — and
        // reporting on it with full confidence (D-40).
        throw new Error(
          `tree hash mismatch after applying: you sent ${tree_hash}, the patch produced ${applied}. ` +
            `Nothing was reviewed. Re-send the full diff for the tree you actually have.`,
        );
      }

      store.updateReview(review_id, { state: "queued", treeHash: applied });
      deps.enqueue(review_id, "fast");
      return text(JSON.stringify({ review_id, state: "queued", tree_hash: applied }));
    },
  );

  // ----------------------------------------------------------- review.attest

  server.registerTool(
    "review_attest",
    { description: TOOL_DOCS.attest, inputSchema: z.object({ review_id: z.string().min(1) }) },
    async ({ review_id }) => {
      const review = mine(review_id);
      if (!isAttestable(review.state)) {
        throw new Error(
          `review is '${review.state}' — there is nothing to attest. ` +
          `Only 'passed' and 'passed_partial' can be attested, and only 'passed' is clean. ` +
            `An attestation for an incomplete review would be a false claim.`,
        );
      }
      return text(await deps.attest(review_id));
    },
  );

  // ------------------------------------------------------------ review.inbox

  server.registerTool(
    "review_inbox",
    { description: TOOL_DOCS.inbox, inputSchema: z.object({}) },
    async () => {
      const reviews = store.listReviews(who.principal);
      const items = reviews.map((r) => {
        const fresh = store.undelivered(r.id);
        store.markDelivered(r.id, fresh.map((f) => f.fingerprint));
        return {
          review_id: r.id,
          branch: r.branch,
          state: r.state,
          clean: r.state === "passed",
          new_findings: fresh.length,
          // This is the field a client triages on, so it is computed, not read off
          // the front of the list. It used to be `fresh[0].severity` with "high"
          // special-cased — and since the query sorted severity as text, a review
          // whose worst finding was medium reported `highest: "low"` (D-50).
          highest: worstSeverity(fresh.map((f) => f.severity)) ?? null,
          findings: fresh.map((f) => ({
            fingerprint: f.fingerprint.slice(0, 8),
            file: f.file,
            severity: f.severity,
            claim: f.claim,
          })),
        };
      });
      const needsHuman = items.filter((i) => i.state === "needs_human");
      return text(
        JSON.stringify({
          reviews: items.filter((i) => i.new_findings > 0 || i.state === "needs_human"),
          needs_human: needsHuman.length,
          note:
            needsHuman.length > 0
              ? "Some reviews need a PERSON. Surface these to your user; do not answer them yourself."
              : "Surface high-severity findings to your user rather than only logging them.",
        }),
      );
    },
  );

  // --------------------------------------------------------- knowledge.query

  server.registerTool(
    "knowledge_query",
    {
      description: TOOL_DOCS.query,
      inputSchema: z.object({
        path: absent(z.string()).describe("narrow to a file or directory prefix"),
        contains: absent(z.string()).describe("case-insensitive substring filter"),
      }),
    },
    async ({ path, contains }) => {
      let items = store.knowledgeFor(who.repoId, path);
      if (contains !== undefined) {
        const needle = contains.toLowerCase();
        items = items.filter(
          (k) => k.statement.toLowerCase().includes(needle) || (k.why ?? "").toLowerCase().includes(needle),
        );
      }
      // An empty answer has to explain itself.
      //
      // A client queried this before its repository's first review completed, got
      // `count: 0`, and wrote "the knowledge store is empty" into two manuals. That
      // is the honest reading of a bare zero — and it is wrong in a way that matters,
      // because the memory is the product and "empty" reads as "this does nothing".
      //
      // The cause is D-35: bootstrapping needs a mirror to read, so it runs on the
      // first review rather than at provisioning. Nothing said so, and the very first
      // question a new workgroup asks is this one.
      const empty =
        store.knowledgeFor(who.repoId, undefined, 1).length === 0
          ? "Nothing has been learned about this repository YET — not 'this repo has no conventions'. " +
            "The knowledge base is built from the repo's own docs on the FIRST REVIEW (there has not been one, " +
            "or it did not finish). Start a review, or teach a rule directly with knowledge_teach."
          : undefined;

      return text(
        JSON.stringify({
          count: items.length,
          items: items.map((k) => ({
            id: k.id,
            kind: k.kind,
            source: k.source,
            statement: k.statement,
            why: k.why,
            path: k.path,
            cwe: k.cwe,
            verified_at: k.verifiedAt,
          })),
          note:
            empty ??
            (items.length === 0
              ? "This repository HAS knowledge; nothing matched this filter. Widen it before concluding anything."
              : "Taught rules outrank inferred ones. These are this team's decisions, not suggestions."),
        }),
      );
    },
  );

  // --------------------------------------------------------- knowledge.teach

  server.registerTool(
    "knowledge_teach",
    {
      description: TOOL_DOCS.teach,
      inputSchema: z.object({
        statement: z.string().min(1).describe("the rule or fact, stated plainly"),
        why: z.string().min(1).describe("the reason — a rule without one gets deleted by the next reader"),
        path: absent(z.string()).describe("scope it to a file or directory when it is not repo-wide"),
        kind: absent(z.enum(["rule", "fact", "mistake"])),
      }),
    },
    async ({ statement, why, path, kind }) => {
      const item = store.addKnowledge({
        repoId: who.repoId,
        kind: kind ?? "rule",
        source: "taught",
        statement,
        why,
        ...(path !== undefined ? { path } : { path: undefined }),
        cwe: undefined,
        provenance: `taught by ${who.principal}`,
        sourceBlob: undefined,
        confidence: 1,
      });
      return text(JSON.stringify({ id: item.id, recorded: true }));
    },
  );

  // -------------------------------------------------------------- review.vex

  server.registerTool(
    "review_vex",
    {
      description: TOOL_DOCS.vex,
      inputSchema: z.object({ review_id: z.string().min(1) }),
    },
    async ({ review_id }) => {
      const review = mine(review_id);
      const doc = buildVex(
        store,
        review_id,
        { name: review.branch, version: review.treeHash ?? "unknown" },
        new Date().toISOString(),
      );
      return text(
        JSON.stringify({
          summary: renderVex(doc),
          untriaged: findingsNeedingTriage(store, review_id).length,
          document: doc,
        }),
      );
    },
  );

  // ------------------------------------------------------- knowledge.resolve

  server.registerTool(
    "knowledge_resolve",
    {
      description: TOOL_DOCS.resolve,
      inputSchema: z.object({
        keep: z.string().min(1).describe("id of the rule that is correct"),
        retire: z.string().min(1).describe("id of the rule that is wrong"),
        reason: z.string().min(1).describe("why — this is recorded and outlives both of you"),
      }),
    },
    async ({ keep, retire, reason }) => {
      const settled = store.resolveConflict(who.repoId, keep, retire, reason);
      if (!settled) {
        throw new Error(
          `no open conflict between ${keep} and ${retire} — check knowledge_query, or it may already be settled`,
        );
      }
      return text(
        JSON.stringify({
          resolved: true,
          retired: retire,
          note: "The losing rule is retired, not deleted: the decision stays reconstructable.",
        }),
      );
    },
  );

  server.registerTool(
    "knowledge_escalate",
    {
      description: TOOL_DOCS.escalate,
      inputSchema: z.object({
        left: z.string().min(1),
        right: z.string().min(1),
        note: z.string().min(1).describe("what you tried, and what a person needs to decide"),
      }),
    },
    async ({ left, right, note }) => {
      store.escalateConflict(who.repoId, left, right, note);
      return text(
        JSON.stringify({
          escalated: true,
          note: "Recorded. This still blocks the review from passing — tell your user a person must decide it.",
        }),
      );
    },
  );

  // ------------------------------------------------------------- resources

  for (const [uri, doc] of Object.entries(RESOURCE_DOCS)) {
    server.registerResource(
      uri,
      uri,
      {
        title: doc.title,
        mimeType: "text/markdown",
        // Assistant-facing, with a priority so a host doing automatic context
        // inclusion picks the workflow doc before the ladder rationale.
        annotations: { audience: ["assistant"], priority: doc.priority },
      },
      async () => ({ contents: [{ uri, mimeType: "text/markdown", text: doc.text }] }),
    );
  }

  // Live data, not documentation.
  //
  // `lore://review/{id}` is deliberately richer than `review_poll`: poll returns
  // deltas so the loop stays cheap, while this returns the whole history for when
  // an agent — or a person — needs to understand how a review reached its verdict.
  server.registerResource(
    "review-trail",
    new ResourceTemplate("lore://review/{review_id}", { list: undefined }),
    { title: "Full audit trail for one review", mimeType: "application/json" },
    async (uri: URL, vars: Record<string, string | string[]>) => {
      const id = String(Array.isArray(vars["review_id"]) ? vars["review_id"][0] : vars["review_id"]);
      const review = mine(id);
      // Verdicts and runs are a chronology, so they order by id; findings are a list
      // someone reads top-down, so they order worst first like everywhere else.
      const findings = store.db
        .prepare(`SELECT * FROM finding WHERE review_id = ? ORDER BY ${FINDING_ORDER_SQL}`)
        .all(id);
      const verdicts = store.db.prepare("SELECT * FROM verdict WHERE review_id = ? ORDER BY id").all(id);
      const runs = store.db.prepare("SELECT * FROM tier_run WHERE review_id = ? ORDER BY id").all(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ review, tierRuns: runs, findings, verdicts }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "knowledge-at-path",
    new ResourceTemplate("lore://knowledge/{+path}", { list: undefined }),
    { title: "What is known about a path", mimeType: "application/json" },
    async (uri: URL, vars: Record<string, string | string[]>) => {
      const path = String(Array.isArray(vars["path"]) ? vars["path"][0] : vars["path"] ?? "");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(store.knowledgeFor(who.repoId, path), null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------- prompt

  server.registerPrompt(
    "review",
    {
      title: "Review a branch before merging",
      description:
        "Drives the whole review loop. An agent handed only tools will improvise the multi-step, stateful part — this is what stops that.",
      argsSchema: z.object({
        branch: z.string().describe("branch under review"),
        into: z.string().describe("branch it will merge into"),
        ticket: z.string().describe("the task text, pasted verbatim"),
      }),
    },
    ({ branch, into, ticket }) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: REVIEW_PROMPT_TEXT(branch, into, ticket) },
        },
      ],
    }),
  );

  return server;
}
