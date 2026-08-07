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
  lore relocate --repo <name> --git <new-url>  a repo moved: keep its history
  lore knowledge [--repo <name>] [--refusals]  what the memory holds, and what it refused
  lore rule --repo <name> [--add ... | --retire ...]  development rules a finding may
                                               be appealed to (D-83)
  lore tokens                                  who holds a token, and for what
  lore revoke --token <short>                  turn one off, by its short hash
  lore doctor                                  check tiers, auth and model ids
  lore propose --repo <name> --budget <n>      ideas for improving a folder (D-75)

  --branch <name>    branch under review (default: current branch)
  --into <name>      branch it will merge into (default: main)
  --ticket <text>    the task text. REQUIRED: without it a reviewer can only ask
                     "is this code correct?", never "is this the right code?"
  --target <path>    repo to review (default: cwd)
  --type <id>        ${reviewTypeIds().join(" | ")} (default: ${DEFAULT_TYPE})
  --db <path>        state file (default: $LORE_DATA_DIR/lore.db, else ~/.lore/lore.db)
  --json             machine-readable output only

lore propose asks the dearest models what they would CHANGE, keeping what the code
does. It gates nothing and implements nothing: a person appraises the document, and any
idea taken goes through the ladder like any other change.

  --repo <name>      which registered repository. REQUIRED
  --budget <n>       MODEL SESSIONS to spend, proposers and critics both. REQUIRED,
                     because a run can empty a rolling subscription window and stall
                     every review in the system
  --folder <path>    the directory the proposals must be ABOUT (default: whole repo)
  --commit <ref>     what to think about (default: master), cut from lore's own mirror
  --mode <id>        ${reviewTypeIds().join(" | ")} (default: ${DEFAULT_TYPE})
  --lens <a,b,c>     data | failure | seams | greenfield (default: all four)
  --out <dir>        where to write the document (default: proposals/)

It refuses to start while any review is queued or running: reviews are the product and
this is inspiration.

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
  readonly db: string;
  readonly json: boolean;
}

function flagOf(argv: readonly string[], name: string): string | undefined {
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
    // LORE_DATA_DIR before the home directory, because the deployment sets it and a
    // container has no home worth writing to: `lore new` inside one died on
    // `EACCES: mkdir '/.lore'`, having ignored the data directory mounted beside it.
    // Same shape as every other invisible default this project has been bitten by —
    // the service and the CLI disagreed about where state lives, and neither said so.
    db: flag("db") ?? join(process.env["LORE_DATA_DIR"] ?? join(homedir(), ".lore"), "lore.db"),
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
        publicUrl: flagOf(argv, "url") ?? "http://lore.internal:7777/mcp",
      });
      process.stdout.write(renderProvisioned(result));
      return EXIT.PASS;
    } finally {
      store.close();
    }
  }

  if (args.command === "propose") {
    const { proposeCli, parseBudget, parseLenses } = await import("./propose/cli.ts");
    const { Reviewer, DEFAULT_REVIEWER } = await import("./reviewer/opencode.ts");
    const repo = flagOf(argv, "repo");
    if (repo === undefined) {
      throw new UsageError(
        "usage: lore propose --repo <name> --budget <sessions> [--folder src/store] [--commit <ref>] " +
          "[--mode code-arch] [--lens seams,failure,data,greenfield]",
      );
    }
    const store = new Store(args.db);
    try {
      const path = await proposeCli({
        store,
        reviewer: new Reviewer(DEFAULT_REVIEWER),
        reposRoot: join(process.env["LORE_DATA_DIR"] ?? join(homedir(), ".lore"), "repos"),
        repo,
        budget: parseBudget(flagOf(argv, "budget")),
        // The repository root by default, so a whole-repo run is the EXPLICIT case
        // rather than the accidental one (spec/propose.md §1.1).
        folder: flagOf(argv, "folder") ?? "",
        // The state the next change starts from. A refactor proposed against a feature
        // branch is a refactor of work in progress.
        commit: flagOf(argv, "commit") ?? "master",
        mode: flagOf(argv, "mode") ?? DEFAULT_TYPE,
        lenses: parseLenses(flagOf(argv, "lens")),
        outDir: flagOf(argv, "out") ?? "proposals",
        now: new Date(),
      });
      process.stdout.write(`${path}\n`);
      return EXIT.PASS;
    } finally {
      store.close();
    }
  }

  // THE PRODUCT HAD NO OPERATOR VIEW. `lore` could list tokens, repositories and tiers;
  // the memory this service exists to build could only be read with hand-written SQL
  // through the container, which meant only whoever wrote the SQL could read it.
  if (args.command === "knowledge") {
    const { knowledgeReport, renderKnowledge } = await import("./knowledge/report.ts");
    const store = new Store(args.db);
    try {
      const want = flagOf(argv, "repo");
      const repos = store.repos().filter((r) => want === undefined || r.name === want);
      if (repos.length === 0) {
        process.stderr.write(
          want === undefined
            ? "no repositories registered — provision one with `lore new`\n"
            : `no repository named ${want}. Registered: ${store.repos().map((r) => r.name).join(", ") || "(none)"}\n`,
        );
        return EXIT.USAGE;
      }
      const reports = repos.map((r) => knowledgeReport(store, r.name, r.id));
      if (args.json) {
        process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
        return EXIT.PASS;
      }
      process.stdout.write(
        `${reports.map((r) => renderKnowledge(r, { refusals: argv.includes("--refusals") })).join("\n\n")}\n`,
      );
      return EXIT.PASS;
    } finally {
      store.close();
    }
  }

  // Development rules, from the operator's side. The client's side is `knowledge_teach`
  // and `knowledge_retire` over MCP; this exists because the person who decides what a
  // team enforces is often at the deployment host holding no token (D-83).
  if (args.command === "rule") {
    const { addRule, ruleReport, renderRules, CITE_LENGTH } = await import("./knowledge/rules.ts");
    const want = flagOf(argv, "repo");
    const store = new Store(args.db);
    try {
      const repos = store.repos().filter((r) => want === undefined || r.name === want);
      const repo = repos[0];
      if (repo === undefined || repos.length > 1) {
        process.stderr.write(
          repos.length > 1
            ? `--repo is required with ${String(repos.length)} repositories registered: ${store.repos().map((r) => r.name).join(", ")}\n`
            : `no repository named ${want ?? "(any)"}. Registered: ${store.repos().map((r) => r.name).join(", ") || "(none)"}\n`,
        );
        return EXIT.USAGE;
      }

      const statement = flagOf(argv, "add");
      const retire = flagOf(argv, "retire");
      if (statement !== undefined) {
        const why = flagOf(argv, "why");
        // REFUSED WITHOUT A REASON, not defaulted. A development rule with no why is the
        // one a later reader deletes because they cannot tell it from an accident — and
        // this rule can switch a check off, so the reader deserves the argument.
        if (why === undefined) throw new UsageError('usage: lore rule --add "<statement>" --why "<reason>" [--path <p>]');
        const path = flagOf(argv, "path");
        const item = addRule(store, repo.id, {
          statement,
          why,
          ...(path !== undefined ? { path } : {}),
          by: `operator on ${repo.name}`,
        });
        process.stdout.write(
          `recorded. Appeal a finding to it with:\n\n  lore-ok[<fingerprint>]: rule ${item.id.slice(0, CITE_LENGTH)} — <why it covers this code>\n\n` +
            "The reviewing tier decides. lore never closes a finding because a rule was cited at it.\n",
        );
        return EXIT.PASS;
      }

      if (retire !== undefined) {
        const why = flagOf(argv, "why");
        if (why === undefined) throw new UsageError("usage: lore rule --retire <short-id> --why \"<why it no longer holds>\"");
        switch (store.retirePolicy(repo.id, retire, `retired by operator: ${why}`)) {
          case "retired":
            process.stdout.write(
              `retired ${retire}. Every check it silenced reports again from the next review; the suppression ` +
                "records are kept as evidence of what earlier reviews did not cover.\n",
            );
            return EXIT.PASS;
          case "ambiguous":
            process.stderr.write(`'${retire}' matches more than one rule — give more characters.\n`);
            return EXIT.USAGE;
          case "not-found":
            process.stderr.write(`no live development rule of ${repo.name} starts with '${retire}'.\n`);
            return EXIT.USAGE;
        }
      }

      process.stdout.write(`${renderRules(ruleReport(store, repo.id))}\n`);
      return EXIT.PASS;
    } finally {
      store.close();
    }
  }

  if (args.command === "tokens") {
    const { listTokens } = await import("./mcp/auth.ts");
    const store = new Store(args.db);
    try {
      const rows = listTokens(store);
      if (rows.length === 0) {
        process.stdout.write("no tokens issued\n");
        return EXIT.PASS;
      }
      for (const t of rows) {
        const state = t.revokedAt === undefined ? "live    " : "revoked ";
        process.stdout.write(
          `${state} ${t.short}  ${t.principal.padEnd(12)} ${t.repo.padEnd(18)} ${t.createdAt}` +
            `${t.label === undefined ? "" : `  ${t.label}`}\n`,
        );
      }
      process.stdout.write("\nrevoke one with: lore revoke --token <short>\n");
      return EXIT.PASS;
    } finally {
      store.close();
    }
  }

  // The command that makes `revocable` true (spec/mcp-api.md §1). Until now the
  // column existed, `make tokens` printed it, and nothing could set it.
  if (args.command === "revoke") {
    const { revokeByPrefix } = await import("./mcp/auth.ts");
    const short = flagOf(argv, "token");
    if (short === undefined) {
      throw new UsageError("usage: lore revoke --token <short-hash> [--db <path>]  (see `lore tokens`)");
    }
    const store = new Store(args.db);
    try {
      const r = revokeByPrefix(store, short);
      switch (r.kind) {
        case "revoked":
          process.stdout.write(`revoked ${short} — ${r.principal} on ${r.repo}. Every client using it now fails auth.\n`);
          return EXIT.PASS;
        case "already-revoked":
          // Not a failure. A second run of the same command must not read as
          // "that token was never here".
          process.stdout.write(`${short} was already revoked at ${r.at}. Nothing to do.\n`);
          return EXIT.PASS;
        case "ambiguous":
          // git's rule, and the reason it matters more here than for a fingerprint:
          // picking a winner locks out a teammate AND leaves the leaked token live.
          process.stderr.write(
            `'${short}' matches ${r.matches.length} tokens (${r.matches.join(", ")}) — give more characters.\n`,
          );
          return EXIT.USAGE;
        case "not-found":
          process.stderr.write(`no token starts with '${short}'. Run \`lore tokens\` for the list.\n`);
          return EXIT.USAGE;
      }
    } finally {
      store.close();
    }
  }

  if (args.command === "relocate") {
    const { relocate, renderRelocation, RelocateError } = await import("./service/relocate.ts");
    const repo = flagOf(argv, "repo");
    const git = flagOf(argv, "git");
    if (repo === undefined || git === undefined) {
      throw new UsageError("usage: lore relocate --repo <name|url|id> --git <new-url> [--db <path>]");
    }
    const store = new Store(args.db);
    try {
      process.stdout.write(renderRelocation(relocate(store, repo, git)));
      return EXIT.PASS;
    } catch (e) {
      // A refusal here is the feature, not a crash: every branch of it prevents a
      // repository's memory being split or attached to the wrong code.
      if (e instanceof RelocateError) {
        process.stderr.write(`${e.message}\n`);
        return EXIT.DID_NOT_RUN;
      }
      throw e;
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

    // Marked failed when the round throws, exactly as the worker does.
    //
    // Without this a CLI review that died sat in `running` for ever: the tier_run
    // said `failed 1801s` while the review row still claimed to be working, so
    // `make status` showed a review in flight that nothing was flying. The worker
    // path already got this right and quotes INV-1 while doing it — a review that
    // did not run is not a review that found nothing — and the second entry point
    // simply never received the same treatment.
    let result;
    try {
      result = await runRound({
        store,
        reviewer: new Reviewer(),
        reviewId,
        principal,
        worktree: args.target,
        type,
      });
    } catch (e) {
      // lore-ok[178a57e7]: the finding says this marks the review failed without
      // marking the round's tier_run failed, leaving an open row beside a failed
      // review. It does not: `runRound` owns that row and closes it on every path
      // before anything reaches here.
      //
      // In src/reviewer/review.ts, reading the model tier's block in order:
      //   openTierRun(...)                          opens it
      //   closeTierRun(tierRunId, findings|clean)   success
      //   catch: closeTierRun(tierRunId, ...)       BEFORE either rethrow
      //   if (!(e instanceof Exhausted)) throw e    rethrow #1, already closed
      //   if (!anyTierRan(...)) throw e             rethrow #2, already closed
      // and T0's own open/close wraps its call the same way.
      //
      // That success line said `"answered"` until the outcome vocabulary changed in
      // the same branch that wrote this, and the justification was not updated with
      // it. The ARGUMENT survived the edit and the
      // EVIDENCE did not, which is the failure mode a reader cannot detect: a
      // citation that no longer matches the file it names is indistinguishable from
      // one that was never checked.
      //
      // So by the time this catch runs, every run this round opened is closed with
      // a real outcome. Closing from out here would need the id, which is private to
      // runRound by design — the layer that opens a row is the layer that knows what
      // happened to it.
      //
      // The reviewer was right about the SHAPE of the bug: a failed review beside a
      // run still claiming to work is exactly the disagreement this view exists to
      // surface. It was fixed one layer down, an hour before this was written.
      store.updateReview(reviewId, { state: "failed" });
      throw e;
    }

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
    // Every repository, deliberately: this runs on the operator's own machine,
    // against their own database, where narrowing would hide their own work.
    .listReviews(principal, undefined)
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
