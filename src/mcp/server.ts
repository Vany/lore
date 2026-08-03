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
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { initialState } from "../core/ladder.ts";
import { isAttestable } from "../core/review-state.ts";
import { DEFAULT_TYPE, reviewType, reviewTypeIds } from "../core/review-type.ts";
import { applyPatch, treeHash } from "../git/repo.ts";
import type { Store } from "../store/store.ts";
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
        type: z.enum(reviewTypeIds() as [string, ...string[]]).optional().describe(`default: ${DEFAULT_TYPE}`),
      }),
    },
    async ({ branch, into, ticket, type }) => {
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
          new_findings: fresh.map((f) => ({
            fingerprint: f.fingerprint.slice(0, 8),
            file: f.file,
            line: f.line,
            symbol: f.symbol,
            severity: f.severity,
            cwe: f.cwe,
            claim: f.claim,
            evidence: f.evidence,
            failure_scenario: f.failureScenario,
            justify_with: `// lore-ok[${f.fingerprint.slice(0, 8)}]: <why this code is correct>`,
          })),
          open_count: store.openFindings(review_id).length,
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
      const worktree = await deps.worktreeFor(review_id);
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
          `review is '${review.state}', not 'passed' — there is nothing to attest. ` +
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
          highest: fresh.some((f) => f.severity === "high") ? "high" : fresh[0]?.severity ?? null,
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
        path: z.string().optional().describe("narrow to a file or directory prefix"),
        contains: z.string().optional().describe("case-insensitive substring filter"),
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
          note: "Taught rules outrank inferred ones. These are this team's decisions, not suggestions.",
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
        path: z.string().optional().describe("scope it to a file or directory when it is not repo-wide"),
        kind: z.enum(["rule", "fact", "mistake"]).optional(),
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
