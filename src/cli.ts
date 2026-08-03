/**
 * The CLI: the development surface (D-16), and the thing that runs one real review
 * without HTTP, containers or tokens in the loop.
 *
 * MCP is the product, but every hard part — agentic reviewing, structured output,
 * escalation, ledger reconciliation — is far easier to iterate on here. This is
 * also what replaces the bash predecessor while the service is being built.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EXIT, LoreError, UsageError, type ExitCode } from "./core/errors.ts";
import { compareFindings } from "./core/finding.ts";
import { initialState } from "./core/ladder.ts";
import { DEFAULT_TYPE, reviewType, reviewTypeIds } from "./core/review-type.ts";
import { gitMaybe } from "./git/exec.ts";
import { treeHash } from "./git/repo.ts";
import { Reviewer } from "./reviewer/opencode.ts";
import { runRound } from "./reviewer/review.ts";
import { enrich, renderEnrichment } from "./knowledge/enrich.ts";
import { Store, type RecordedFinding } from "./store/store.ts";

const USAGE = `
lore — an independent reviewer that remembers the codebase

  lore review --branch <name> --into <name> --ticket <text> [options]
  lore serve                                   run the MCP service
  lore new --name <who> --git <ssh-url>        provision a repo and token
  lore doctor                                  check tiers, auth and model ids

  --branch <name>    branch under review (default: current branch)
  --into <name>      branch it will merge into (default: main)
  --ticket <text>    the task text. REQUIRED: without it a reviewer can only ask
                     "is this code correct?", never "is this the right code?"
  --target <path>    repo to review (default: cwd)
  --type <id>        ${reviewTypeIds().join(" | ")} (default: ${DEFAULT_TYPE})
  --run-tests        execute the target's test suite in a sandbox
  --db <path>        state file (default: ~/.lore/lore.db)
  --json             machine-readable output only

Exit codes: 0 passed · 1 findings · 2 usage · 3 partial (some tiers unpayable)
            70 did not run · 75 no tier could run at all
`.trim();

interface Args {
  readonly command: string;
  readonly branch?: string;
  readonly into: string;
  readonly ticket?: string;
  readonly target: string;
  readonly type: string;
  readonly runTests: boolean;
  readonly db: string;
  readonly json: boolean;
}

export function flagOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function parseArgs(argv: readonly string[]): Args {
  const flag = (name: string): string | undefined => flagOf(argv, name);
  const has = (name: string): boolean => argv.includes(`--${name}`);

  return {
    command: argv[0] ?? "",
    ...(flag("branch") !== undefined ? { branch: flag("branch") ?? "" } : {}),
    into: flag("into") ?? "main",
    ...(flag("ticket") !== undefined ? { ticket: flag("ticket") ?? "" } : {}),
    target: resolve(flag("target") ?? process.cwd()),
    type: flag("type") ?? DEFAULT_TYPE,
    runTests: has("run-tests"),
    db: flag("db") ?? join(homedir(), ".lore", "lore.db"),
    json: has("json"),
  };
}

export async function main(argv: readonly string[]): Promise<ExitCode> {
  const args = parseArgs(argv);

  if (args.command === "serve") {
    const { configFromEnv, serve } = await import("./service/main.ts");
    await serve(configFromEnv());
    // Runs until killed. Returning would tear down the workers mid-review.
    await new Promise(() => {});
    return EXIT.PASS;
  }

  if (args.command === "doctor") {
    const { doctor, render, healthy } = await import("./service/doctor.ts");
    const checks = await doctor();
    process.stdout.write(`${render(checks)}\n`);
    return healthy(checks) ? EXIT.PASS : EXIT.DID_NOT_RUN;
  }

  if (args.command === "new") {
    const { provision, renderProvisioned } = await import("./service/provision.ts");
    const name = flagOf(argv, "name");
    const gitUrl = flagOf(argv, "git");
    if (name === undefined || gitUrl === undefined) {
      throw new UsageError("usage: lore new --name <who> --git <ssh-url> [--db <path>] [--url <public-url>]");
    }
    await mkdir(dirOf(args.db), { recursive: true });
    const store = new Store(args.db);
    try {
      const result = await provision({
        store,
        name,
        gitUrl,
        keysDir: join(dirOf(args.db), "keys"),
        publicUrl: flagOf(argv, "url") ?? "http://lore.internal:7777/mcp",
      });
      process.stdout.write(renderProvisioned(result));
      return EXIT.PASS;
    } finally {
      store.close();
    }
  }

  if (args.command !== "review" || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return args.command === "review" ? EXIT.PASS : EXIT.USAGE;
  }

  // Required, not optional: scope creep — the most common defect in this workflow
  // — is invisible to a reviewer that does not know what was asked (D-38).
  if (args.ticket === undefined || args.ticket.trim().length === 0) {
    throw new UsageError("--ticket is required: the reviewer must know what was asked, not just what was written");
  }

  const branch =
    args.branch ?? (await gitMaybe(args.target, ["rev-parse", "--abbrev-ref", "HEAD"]));
  if (branch === undefined || branch === "HEAD") {
    throw new UsageError("cannot determine the branch — pass --branch");
  }

  await mkdir(join(args.db, "..").replace(/\/[^/]*$/, ""), { recursive: true }).catch(() => undefined);
  await mkdir(dirOf(args.db), { recursive: true });

  const store = new Store(args.db);
  try {
    const origin = (await gitMaybe(args.target, ["remote", "get-url", "origin"])) ?? args.target;
    const repo = store.upsertRepo(basename(args.target), origin);
    const type = reviewType(args.type);

    // The CLI is single-user, so the principal is a constant. The service supplies
    // a real one from the bearer token (D-23).
    const principal = "cli";
    const reviewId = existingReview(store, principal, branch) ?? randomUUID();

    if (store.getReview(reviewId, principal) === undefined) {
      const tree = await treeHash(args.target).catch(() => undefined);
      store.createReview({
        id: reviewId,
        repoId: repo.id,
        principal,
        branch,
        intoRef: args.into,
        ticket: args.ticket,
        type: type.id,
        state: "running",
        ladder: initialState(type.tiers),
        ...(tree !== undefined ? { treeHash: tree } : {}),
      });
    }

    const result = await runRound({
      store,
      reviewer: new Reviewer(),
      reviewId,
      principal,
      worktree: args.target,
      type,
      runTests: args.runTests,
    });

    const undelivered = store.undelivered(reviewId);
    store.markDelivered(reviewId, undelivered.map((f) => f.fingerprint));

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ reviewId, decision: result.decision, findings: undelivered }, null, 2)}\n`);
    } else {
      // History is what turns a defect into a pattern: "seen 4x, and the rule from
      // 2026-07-11 says X" is a different object from the same finding raised cold.
      const history = new Map(
        undelivered.map((f) => [f.fingerprint, renderEnrichment(enrich(store, repo.id, f))]),
      );
      process.stdout.write(
        render(reviewId, result.decision.kind, undelivered, result.t0Unavailable, result.accepted, result.rejected, result.expired, history),
      );
    }

    switch (result.decision.kind) {
      case "passed":
        return EXIT.PASS;
      case "passedPartial":
        return EXIT.PARTIAL;
      case "stopped":
        return EXIT.DID_NOT_RUN;
      default:
        return EXIT.FINDINGS;
    }
  } finally {
    store.close();
  }
}

function existingReview(store: Store, principal: string, branch: string): string | undefined {
  // Reviews are snapshot-pinned and explicitly started (D-40), but the CLI is a
  // loop driver: resume the open review for this branch rather than starting a new
  // one and losing every justification already accepted.
  return store
    .listReviews(principal)
    .find((r) => r.branch === branch && r.state !== "passed" && r.state !== "expired")?.id;
}

function render(
  reviewId: string,
  decision: string,
  findings: readonly RecordedFinding[],
  unavailable: readonly string[],
  accepted: readonly string[],
  rejected: readonly string[],
  expired: readonly string[],
  history: ReadonlyMap<string, string | undefined>,
): string {
  const out: string[] = ["", `# lore — ${decision}`, `_review ${reviewId}_`, ""];

  if (unavailable.length > 0) {
    out.push("## Not checked", "", "Nothing verified these. Do not read them as clean.", "");
    for (const u of unavailable) out.push(`- ${u}`);
    out.push("");
  }

  if (accepted.length > 0) out.push(`Accepted ${accepted.length} justification(s).`, "");
  if (expired.length > 0) {
    out.push(
      `**${expired.length} justification(s) expired** — the code they were about has changed, so the reasons`,
      "no longer apply and those findings are open again.",
      "",
    );
  }
  if (rejected.length > 0) {
    out.push(
      `**Rejected ${rejected.length} justification(s)** — the reviewer looked and raised the finding anyway.`,
      "A mistaken justification matters more than a fresh bug, because it was trusted.",
      "",
    );
  }

  if (findings.length === 0) {
    out.push(decision === "passed" ? "No findings. Every tier agrees." : "No new findings this round.", "");
  } else {
    out.push(`## ${findings.length} finding(s)`, "");
    // The store already orders these worst-first. Sorting again is redundant for
    // that path and is kept so the renderer does not depend on its caller having
    // done so — T0's findings never went through the store at all. The cost is one
    // O(n log n) sort over a list a human is about to read; unmeasured, and not
    // claimed to be free.
    for (const f of [...findings].sort(compareFindings)) {
      const where = `${f.file}${f.line !== undefined ? `:${f.line}` : ""}`;
      out.push(
        `### [${f.severity}] ${where}${f.cwe !== undefined ? `  (${f.cwe})` : ""}`,
        "",
        f.claim,
        "",
        `- evidence: ${f.evidence}`,
        `- failure: ${f.failureScenario}`,
        `- fix it, or justify it:  \`// lore-ok[${f.fingerprint.slice(0, 8)}]: <why this code is correct>\``,
        ...(history.get(f.fingerprint) === undefined ? [] : [`- history: ${history.get(f.fingerprint) ?? ""}`]),
        "",
      );
    }
  }

  if (decision !== "passed") {
    out.push("---", "", "This is NOT a pass. Fix or justify, then run again.", "");
  }
  return out.join("\n");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "." : p.slice(0, i);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export { EXIT, LoreError };
