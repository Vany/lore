/**
 * The service entry point: HTTP host, background workers, heartbeat.
 *
 * Everything is wired here so the wiring is in one readable place rather than
 * spread across modules that each know a little too much about the others.
 */

import { join } from "node:path";
import { repinReview } from "./repin.ts";
import { fallbackRoutes, ladderIsOperatorWritten, loadPools, loadTiers } from "../core/ladder.ts";
import { dataDir, dbDir, dbFileIn } from "../core/paths.ts";
import { mkdir } from "node:fs/promises";
import { Alerter, CONDITIONS } from "../ops/alerts.ts";
import { DEFAULT_HEARTBEAT, startHeartbeat, type HeartbeatConfig } from "../ops/heartbeat.ts";
import { DEFAULT_RETENTION, collect } from "../ops/retention.ts";
import { repoPaths, worktreeFor } from "../git/repo.ts";
import { DEFAULT_REVIEWER, Reviewer } from "../reviewer/opencode.ts";
import { Store } from "../store/store.ts";
import { attest, render } from "./attest.ts";
import { enqueueOrFail } from "./enqueue.ts";
import { RESCREEN_INTERVAL_MS, screeningPass } from "./screening.ts";
import { startHttp } from "./http.ts";
import { serveRefusing } from "./refusing.ts";
import { METERED_YES } from "../core/metered.ts";
import { DEFAULT_WORKER, Worker } from "./worker.ts";

export interface ServiceConfig {
  readonly dataDir: string;
  /**
   * Where `lore.db` lives, when that is not `dataDir`.
   *
   * Split because the two have opposite requirements. `dataDir` MUST be a host bind:
   * the T0 sandbox asks the host daemon to bind a worktree into a sibling container by
   * absolute path, and the daemon resolves it on the host. SQLite must NOT be on one:
   * on Docker Desktop for macOS a bind is virtiofs, whose locking SQLite's own
   * howtocorrupt.html §2.1 names as a corruption cause when two processes share the
   * file — which lore and litestream do, and which cost three corruptions in three days.
   *
   * Defaults to `dataDir`, so a deployment that has not been split behaves exactly as
   * it did and the CLI keeps working against a plain directory.
   */
  readonly dbDir?: string;
  readonly port: number;
  readonly host: string;
  readonly webhookUrl?: string;
  readonly heartbeatUrl?: string;
  /**
   * Litestream's replica folder, mounted read-only so the service can page when the
   * knowledge base has stopped being replicated.
   *
   * Unset is a supported deployment and reports `replica: "unconfigured"` rather than
   * anything green — the check cannot run, which is not the same as passing.
   */
  readonly backupDir?: string;
  /**
   * May a fallback chain walk onto a route that bills per call (D-117)?
   *
   * DEFAULTS TO NO, and that is the decision rather than a timid default. A deployment
   * running on flat subscriptions has never agreed to an invoice, and the failure of
   * defaulting the other way is measured: 2026-08-16, $101.36 in three and a half hours,
   * discovered from a total four hours after the first paid call.
   */
  readonly allowMetered: boolean;
}

/**
 * A variable set to NOTHING is not set.
 *
 * `.env` files spell "unconfigured" as `LORE_WEBHOOK_URL=`, so the value arrives as
 * an empty string rather than absent — and `??` only catches `undefined`. Every
 * reader here had that hole, with three different consequences:
 *
 *   * `fetch("")` on every alert, which throws and logs a failure that looks like a
 *     broken webhook rather than an absent one;
 *   * the heartbeat posting to nowhere while the operator believes it is off;
 *   * and the one that matters — `Number("")` is **0**. When a blank
 *     `LORE_CONCURRENCY` meant zero worker loops, the service bound, answered
 *     `/status` with `ok: true`, accepted reviews, queued them and ran none, for
 *     ever. That knob is gone (D-101) and the hazard is not: any numeric setting
 *     read this way turns "unconfigured" into a working value of zero.
 */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v;
}

/**
 * A number, or the default — but never a number the operator did not write.
 *
 * Blank means "use the default" and is normal. GARBAGE means the deployment is
 * misconfigured, and silently substituting a default there would hide it until
 * someone wondered why a knob had no effect. It throws at startup, which is the
 * one moment a person is watching.
 */
function envNumber(name: string, fallback: number, min = 0): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`${name} is "${raw}", which is not a number >= ${min}. Fix it or leave it empty for ${fallback}.`);
  }
  return n;
}

/**
 * A yes/no the operator wrote, and nothing else.
 *
 * Same rule as `envNumber` and it matters more here, because this one spends money: an
 * unrecognised value must never be read as either answer. `LORE_ALLOW_METERED=maybe`
 * silently meaning "no" would strip tiers out of every review during an outage; silently
 * meaning "yes" would buy them. It throws, at the one moment somebody is watching.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  // THE YES LIST IS SHARED with `make status`, which reads the same variable to say what a
  // tier cool-off costs. Two private copies disagreed once — status tested `=== "1"` — so
  // `LORE_ALLOW_METERED=true` paid for fallbacks while the operator view said it did not.
  if (METERED_YES.includes(v as (typeof METERED_YES)[number])) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} is "${raw}", which is not a yes or a no. Use 1/0, true/false, yes/no, or leave it empty.`);
}

export function configFromEnv(): ServiceConfig {
  // A SETTING THAT NO LONGER DOES ANYTHING IS DECORATION A READER BELIEVES.
  //
  // `LORE_MODEL_CONCURRENCY` capped model calls in flight and queued the rest until D-98
  // moved the bound to admission. Reading it and ignoring it would leave an operator
  // holding a knob wired to nothing — believing they had tuned provider load while the
  // real bound, admission, sat where they were not looking. This repo has been bitten by the
  // decorative-constant shape twice (`RULE_DIRS`, `SCHEMA_VERSION`), so it refuses at
  // startup instead: the fix is deleting one line and the message says so.
  if (env("LORE_CONCURRENCY") !== undefined) {
    throw new Error(
      "LORE_CONCURRENCY is set but no longer does anything (D-101): there is no worker pool. " +
        "A claimed job starts its round immediately, so nothing sits in `queued` waiting for a " +
        "loop to free up, and the only bound is admission — a new review is refused at 128 open. " +
        "Remove the variable.",
    );
  }
  if (env("LORE_MODEL_CONCURRENCY") !== undefined) {
    throw new Error(
      "LORE_MODEL_CONCURRENCY is set but no longer does anything (D-98): model calls are " +
        "no longer queued behind a semaphore — a round launches its session immediately, and the " +
        "bound is admission control, which refuses a new review at 128 open. Remove the variable.",
    );
  }
  // AND THE LOUDEST ONE, because believing this knob still works is believing lore has a
  // spending limit when it has none (D-121). An operator who left `LORE_DAILY_CEILING_USD`
  // in place has every reason to think a number caps the day. Nothing does; what bounds
  // the money now is whether metered routes may be used at all, which is a different
  // question with a different answer, so the message names the replacement rather than
  // just refusing.
  if (env("LORE_DAILY_CEILING_USD") !== undefined) {
    throw new Error(
      "LORE_DAILY_CEILING_USD is set but no longer does anything (D-121): price is reported, " +
        "never acted on, so no total stops a review — the ceiling used to suspend the gate for " +
        "everybody over a bill one batch ran up. What bounds spending now is LORE_ALLOW_METERED " +
        "(default 0), which decides whether a fallback may walk onto a per-call route at all " +
        "(D-117). Remove the variable, and set LORE_ALLOW_METERED=1 if you want paid fallbacks.",
    );
  }
  const webhookUrl = env("LORE_WEBHOOK_URL");
  const heartbeatUrl = env("LORE_HEARTBEAT_URL");
  const backupDir = env("LORE_BACKUP_DIR");
  return {
    // Through `paths.ts`, which is the one definition. The service used to default to
    // `/var/lib/lore` while the CLI defaulted to `~/.lore`, so the two disagreed about
    // where state lived whenever the variable was unset — and the container always sets
    // it, which is exactly what kept that from being noticed.
    dataDir: dataDir(),
    dbDir: dbDir(),
    port: envNumber("LORE_PORT", 7777, 1),
    // Binds to the tailnet interface in production; 0.0.0.0 inside a container
    // that is only reachable through it.
    host: env("LORE_HOST") ?? "0.0.0.0",
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    ...(heartbeatUrl !== undefined ? { heartbeatUrl } : {}),
    ...(backupDir !== undefined ? { backupDir } : {}),
    allowMetered: envBool("LORE_ALLOW_METERED", false),
  };
}

/**
 * Open the database, or say why not — never throw.
 *
 * Two ways it can be unusable and both must land here. The constructor itself can die
 * (its `DDL` and migrations are statements like any other), and it can succeed against a
 * file whose damage is in a tree nothing has touched yet — which is what happened: the
 * open went through, `PRAGMA quick_check` would have caught it, and the first real
 * transaction was where it surfaced, four frames inside a worker.
 *
 * `integrityFault` opens a FRESH read-only connection deliberately. Asking the live
 * handle answers from its page cache, which is how a check can report clean against a
 * file no other process can read at all.
 */
function openOrRefuse(dbPath: string): { readonly store: Store } | { readonly fault: string } {
  let store;
  try {
    store = new Store(dbPath);
  } catch (e) {
    return { fault: e instanceof Error ? e.message : String(e) };
  }
  const fault = store.integrityFault();
  if (fault === undefined) return { store };
  // Closed before refusing. A held handle on a damaged file keeps its WAL and shm alive
  // and gives a restore something to fight with.
  try {
    store.close();
  } catch {
    // A corrupt database can fail to close. The answer is already known.
  }
  return { fault };
}

export async function serve(cfg: ServiceConfig): Promise<() => void> {
  await mkdir(cfg.dataDir, { recursive: true });
  // BOTH DIRECTORIES, because they stopped being the same one.
  //
  // Only `dataDir` was created, so a `LORE_DB_DIR` pointing at a directory that does not
  // exist yet — a fresh install, which is every install once — made `new Store()` throw,
  // and `openOrRefuse` classifies any throw as corruption. The service then refused to
  // serve and told the operator to run `make backup-check` and `make restore`, on a box
  // with no backup and nothing to restore, and would not retry after the directory was
  // created. The most innocent state in the system, answered with its gravest message.
  await mkdir(cfg.dbDir ?? cfg.dataDir, { recursive: true });
  const dbFile = dbFileIn(cfg.dbDir ?? cfg.dataDir);

  // BEFORE ANYTHING ELSE, AND WITHOUT EXITING IF IT FAILS.
  //
  // A malformed database made every statement throw, `reclaimOrphanedJobs` took the
  // process with it, `main()` exited 70, Docker restarted, and that loop would have run
  // for ever — with `/status` refusing connections the whole time, which reads exactly
  // like the machine being off. The heartbeat's integrity check, added the day before
  // for the same fault, never got to run: it only runs while the service is healthy
  // enough to run it.
  //
  // So the check moves to the one moment that is always reached, and a failure serves a
  // refusal instead of dying. `serveRefusing` starts NO worker, NO heartbeat and NO
  // sweep: writing into a damaged file is how a recoverable fault becomes permanent.
  const opened = openOrRefuse(dbFile);
  if ("fault" in opened) {
    // The page goes out first, in case nobody ever curls anything. Fire-and-forget by
    // design — an alert that blocks startup on a webhook timeout is a second outage.
    void new Alerter({
      ...(cfg.webhookUrl !== undefined ? { webhookUrl: cfg.webhookUrl } : {}),
      timeoutMs: 10_000,
    }).send(CONDITIONS.databaseUnreadable(opened.fault));
    const refusal = serveRefusing({ port: cfg.port, bind: cfg.host, dbPath: dbFile, fault: opened.fault });
    return refusal.stop;
  }
  const store = opened.store;

  const alerter = new Alerter({
    ...(cfg.webhookUrl !== undefined ? { webhookUrl: cfg.webhookUrl } : {}),
    timeoutMs: 10_000,
  });

  const reposRoot = join(cfg.dataDir, "repos");
  const keyPath = join(cfg.dataDir, "attest_ed25519.pem");

  // Built here rather than defaulted inside Worker, so the gate is ONE instance
  // shared by every worker loop. A reviewer per loop would give each its own gate and
  // the limit would silently multiply by the worker count — the bound would read as 4
  // and behave as 48 at LORE_CONCURRENCY=12, which is the number that killed four
  // reviews in the first place.
  // KEPT SESSIONS OUTLIVE THIS PROCESS (D-80). Without this port the reviewer holds them
  // in memory alone, so a deploy silently downgraded every open review to a cold re-read
  // of its whole diff — the expensive half of a restart, and the half nothing reported.
  // Vany: *"deployment must not kill the full ladder, may be one step."*
  const reviewer = new Reviewer({
    ...DEFAULT_REVIEWER,
    keptSessions: {
      get: (key) => store.keptSessionOf(key),
      set: (key, sessionId) => {
        store.setKeptSession(key, sessionId);
      },
      forget: (key) => {
        store.forgetKeptSession(key);
      },
      keys: () => store.keptSessionKeys(),
    },
  });

  // THE DEFAULT LADDER IS ENTIRELY METERED, AND NOBODY CHOSE IT (D-117).
  //
  // `DEFAULT_TIERS` is three literal `openrouter/` models. With no `LORE_TIERS` and no
  // metered permission, every tier is gated and no review can reach a model at all — so
  // the service would run, accept work, and return `passed_partial` with everything in
  // `checks_skipped`, for ever, looking like a configured deployment. That is the shape
  // this project refuses: it says so, once, at the one moment somebody is watching.
  //
  // A LOG AND NOT A THROW, deliberately. Refusing to boot would make a fresh `make up`
  // fail for anyone who has not written a tiers file yet, and the honest state here is
  // "running, and unable to review anything" — which is recoverable by either of the two
  // things this line names.
  if (!ladderIsOperatorWritten() && !cfg.allowMetered) {
    console.error(
      "lore: NO REVIEW CAN RUN. LORE_TIERS is unset, so the built-in ladder is in use — and every one of its " +
        "tiers is an `openrouter/` route, which bills per call. LORE_ALLOW_METERED=0 refuses those, so every " +
        "tier will be skipped and every verdict will be `passed_partial` having read nothing. Fix it by " +
        "setting LORE_TIERS to a ladder on your own subscriptions, or LORE_ALLOW_METERED=1 to pay per call.",
    );
  }

  const worker = new Worker(
    store,
    { ...DEFAULT_WORKER, reposRoot, allowMetered: cfg.allowMetered },
    alerter,
    reviewer,
  );
  const stopWorker = worker.start();

  // ONE heartbeat config, used by both readers.
  //
  // It was built twice in this function — once for `startHeartbeat` and once for the
  // `/status` handler below — and the copies were already free to drift. They would
  // have, on this very change: adding the replica folder to the beat alone leaves
  // `/status` answering `replica: "unconfigured"` while the beat pages that it is
  // behind, which is two opposite claims about one directory from one process.
  // `url` is the one difference, and it belongs to the beat because only the beat
  // posts anything.
  const heartbeat: HeartbeatConfig = {
    ...DEFAULT_HEARTBEAT,
    ...(cfg.backupDir !== undefined ? { backupDir: cfg.backupDir } : {}),
    dataDir: cfg.dataDir,
  };

  const stopBeat = startHeartbeat(
    store,
    { ...heartbeat, ...(cfg.heartbeatUrl !== undefined ? { url: cfg.heartbeatUrl } : {}) },
    alerter,
  );

  // Sweep hourly. Worktrees and finished reviews go; the knowledge tables never do
  // — a deleted review costs one re-run, deleted knowledge costs everything the
  // workgroup ever taught the service.
  const sweep = setInterval(() => {
    // NOTHING SUSPENDS THIS ANY MORE (D-121). The sweep used to be skipped whole while a
    // spend ceiling was reached, because `expired` after 48h of not moving must never be
    // said about somebody who was not moving BECAUSE LORE WAS NOT WORKING. With the
    // ceiling gone lore is never deliberately not working, so the exemption has nothing
    // left to protect against and its absence cannot reap anybody for our outage.
    void collect(store, { ...DEFAULT_RETENTION, reposRoot }).then(
      (r) => {
        if (r.worktreesRemoved + r.reviewsDeleted + r.reviewsExpired > 0) {
          console.error(
            `lore: swept ${r.worktreesRemoved} worktrees, ${r.reviewsDeleted} old reviews, ${r.reviewsExpired} expired`,
          );
        }
      },
      (e: unknown) =>
        void alerter.send({
          severity: "ticket",
          condition: "retention sweep failed",
          detail: e instanceof Error ? e.message : String(e),
        }),
    );
  }, 3_600_000);
  sweep.unref?.();

  // THE SCREEN, OFF THE REVIEW PATH (D-89). Deciding which extracted candidates are not
  // rules is a model call, and it used to run inside `runRound` before the tier — which
  // let a dead cheap tier wedge a review before any tier had been asked anything, at the
  // full hang deadline per changed document.
  //
  // Same hour as the sweep, and nothing waits on either. `DEFAULT_TIERS` is not used: the
  // deployment's own ladder decides which tier is cheapest, and asking a model the
  // configuration does not name would spend quota nobody approved.
  // SINGLE-FLIGHT, not an interval — the same shape `startHeartbeat` uses and for a
  // sharper reason. A pass works the backlog serially, one cheap-tier model call per
  // document version, queued behind reviews at the shared provider gate, so it can
  // outlast the hour. `setInterval` would then start a second pass over the SAME
  // `UNSCREENED` rows: double the quota to ask identical questions, and if the two
  // disagree about a statement the retire always wins by write ordering — so whether a
  // rule survives would be decided by timer interleaving. Scheduling the next pass from
  // the last one's completion makes the hour a floor rather than a promise.
  let screening: ReturnType<typeof setTimeout> | undefined;
  let screeningStopped = false;
  const scheduleScreening = (): void => {
    if (screeningStopped) return;
    screening = setTimeout(() => {
      void screeningPass(store, reviewer, loadTiers()).finally(scheduleScreening);
    }, RESCREEN_INTERVAL_MS);
    screening.unref?.();
  };
  scheduleScreening();

  // EVERY CONFIGURED FALLBACK, CHECKED WHILE SOMEONE IS WATCHING (D-93).
  //
  // A fallback is a promise about what happens when a subscription runs out, and once it
  // is configured nobody worries about that case again. A promise that cannot be kept is
  // worse than none: it fails at the worst moment, looks like the provider being down,
  // and the plan made around it was made for nothing. Startup is the one time a person is
  // looking, so the question is asked here rather than when it is needed.
  //
  // NOT FATAL. The ladder without a fallback is the ladder lore ran for its whole life —
  // an exhausted tier is skipped and its work promoted (D-48) — so refusing to start
  // would turn a degraded configuration into an outage. Loud, and it names the model, so
  // the fix is a one-line edit rather than an investigation.
  void (async () => {
    // EVERY entry of every chain, not just the first: a second fallback nobody can reach
    // is the same broken promise as a first one, and it is the one that gets checked
    // least because it only runs when the account before it is already empty.
    //
    // EXPANDED THROUGH THE POOLS, because a fallback may name one. Unexpanded, this asked
    // opencode whether it could reach `GLM5.2` — a nickname, which is not a model id and
    // never will be — and ticketed that it could not. A check that cries wolf about a
    // healthy fallback is worse than no check: the one time it means something, nobody
    // reads it.
    const wanted = fallbackRoutes(loadTiers(), loadPools());
    if (wanted.length === 0) return;
    // WAIT FOR OPENCODE, because a deploy restarts both containers together and this
    // check used to ask exactly once, at the one moment its counterpart could not yet
    // answer. It printed "could not verify … UNKNOWN" on every deploy this service has
    // ever had — a verification that can never succeed when it runs — and the operator,
    // watching the logs, rightly called it out. Two minutes of patience covers every
    // startup this deployment has seen; only after that is UNKNOWN an honest answer.
    let missing: readonly string[] | undefined;
    for (let attempt = 0; attempt < 24; attempt++) {
      missing = await reviewer.missingModels(wanted).catch(() => undefined);
      if (missing !== undefined) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (missing === undefined) {
      // NOT "ready". opencode stayed unreachable for two minutes, so nothing was
      // verified — and saying "ready" here would be the one claim this check exists to
      // make trustworthy, made without evidence.
      console.error(
        `lore: could not verify the quota fallback (${wanted.join(", ")}) — opencode did not answer with a ` +
          "provider list for two minutes. The ladder is unaffected; whether the fallback would work is UNKNOWN, not confirmed.",
      );
      return;
    }
    if (missing.length === 0) {
      console.error(`lore: quota fallback ready — ${wanted.join(", ")}`);
      return;
    }
    void alerter.send(CONDITIONS.fallbackUnavailable(missing));
  })().catch((e: unknown) => {
    // THE `.catch` "NOT FATAL" ABOVE NEVER MEANT — found by lore's own review,
    // fingerprint dad4747c: `loadTiers()` on the line above throws on a bad
    // LORE_TIERS path or malformed JSON (the same class 15be66bd fixed one file
    // over, and c1b6fc4c/733b59e6 fixed in status.ts/board.ts), and this whole IIFE
    // was `void`-discarded with nothing catching the rejection that produces. An
    // unhandled rejection crashes the WHOLE PROCESS by default — the opposite of
    // "NOT FATAL", on the very first boot-time reader of a ladder file an operator
    // just edited.
    console.error(`lore: the fallback check could not complete: ${e instanceof Error ? e.message : String(e)}`);
  });

  const http = startHttp(
    store,
    {
      store,
      // THE SAME REVIEWER THE WORKER USES, so `review_cancel` can reach the session it
      // is cancelling. Omitting it was not a missing feature: it made `review_cancel`
      // unable to stop spend in the only build that matters, and — worse — say so
      // backwards. `deps.reviewer?.cancel?.()` collapsed to `undefined ?? false`, which
      // the reply rendered as "No model call was in flight" while an opencode session
      // opened seconds earlier kept running and lore's gate kept holding its slot
      // (measured on rev_NYiv0xfO, 2026-08-08). A cancel that cannot stop the model is
      // the failure mode `Reviewer.cancel`'s own comment calls worse than no cancel at
      // all, and it shipped because nothing connected the two objects.
      //
      // ONE INSTANCE, deliberately: `sessions` maps review id to the session in flight,
      // and a second Reviewer would have a second, empty map — a cancel that looks in
      // the wrong drawer and truthfully reports finding nothing.
      reviewer,
      // `review_submit` needs a worktree to apply a diff into and hash. That makes
      // this a base-cutting path exactly as much as the worker's is, so it asks the
      // same question through the same function — it used to call `addWorktree`
      // directly with no freshness check, which let a submit choose a base from a
      // never-fetched mirror (t3, high). The old `.catch(() => <path>)` went with it:
      // it turned any failure into a path to a directory that was never created.
      worktreeFor: async (reviewId) => {
        const at = store.reviewLocation(reviewId);
        const paths = repoPaths(reposRoot, at?.repoId ?? "");
        return worktreeFor(paths, reviewId, at?.branch ?? "", at?.gitUrl ?? "");
      },
      // `enqueueOrFail` and not a closure, because a closure built in here cannot be
      // tested — and the last defect of exactly this shape (the MCP server handed no
      // reviewer) survived its whole life inside one. It is the only path by which a
      // review the client was told is `queued` can silently never run; see there.
      enqueue: (reviewId, stage) => {
        void enqueueOrFail(store, alerter, reviewId, stage);
      },
      repin: (reviewId, expectTree, intoRef) =>
        repinReview(store, reposRoot, dataDir(), reviewId, expectTree, intoRef),
      attest: async (reviewId) => {
        return render(await attest(store, reviewId, store.principalOf(reviewId) ?? "", keyPath));
      },
    },
    {
      port: cfg.port,
      host: cfg.host,
      heartbeat,
      allowMetered: cfg.allowMetered,
      modelGate: () => reviewer.gateState(),
    },
  );

  console.error(`lore listening on ${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`);

  return () => {
    http.close();
    clearInterval(sweep);
    screeningStopped = true;
    if (screening !== undefined) clearTimeout(screening);
    // The event subscription (D-91) holds a socket open and reconnects on its own, so a
    // stop that did not say so would keep the process alive after every test and every
    // shutdown. `screening` likewise: it was added with the timer and not the teardown.
    reviewer.close();
    stopBeat();
    stopWorker();
    store.close();
  };
}
