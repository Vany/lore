/**
 * The service entry point: HTTP host, background workers, heartbeat.
 *
 * Everything is wired here so the wiring is in one readable place rather than
 * spread across modules that each know a little too much about the others.
 */

import { join } from "node:path";
import { dataDir, dbDir, dbFileIn } from "../core/paths.ts";
import { mkdir } from "node:fs/promises";
import { Alerter, CONDITIONS } from "../ops/alerts.ts";
import { DEFAULT_HEARTBEAT, startHeartbeat, type HeartbeatConfig } from "../ops/heartbeat.ts";
import { DEFAULT_RETENTION, collect } from "../ops/retention.ts";
import { DEFAULT_SPEND, mayStart } from "../ops/spend.ts";
import { repoPaths, worktreeFor } from "../git/repo.ts";
import { DEFAULT_REVIEWER, Reviewer } from "../reviewer/opencode.ts";
import { Store } from "../store/store.ts";
import { attest, render } from "./attest.ts";
import { startHttp } from "./http.ts";
import { serveRefusing } from "./refusing.ts";
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
  readonly concurrency: number;
  /** In-flight model calls, sized for the provider rather than for the host. */
  readonly modelConcurrency: number;
  readonly dailyCeilingUsd: number;
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
 *   * and the one that matters — `Number("")` is **0**, so `LORE_CONCURRENCY=`
 *     starts ZERO worker loops. The service binds, answers `/status` with
 *     `ok: true`, accepts reviews, queues them, and runs none of them, for ever.
 *     Healthy and doing nothing is the failure this project exists to refuse.
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
 * someone wondered why the ceiling never fired. It throws at startup, which is the
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

export function configFromEnv(): ServiceConfig {
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
    // At least one: zero workers is a service that queues for ever in silence.
    concurrency: envNumber("LORE_CONCURRENCY", DEFAULT_WORKER.concurrency, 1),
    // A SECOND knob, because the first one governs the wrong resource for this.
    // `LORE_CONCURRENCY` is sized by cores for the local sandbox; this is sized for
    // the provider, which is what actually broke — four reviews dead in 2.5 minutes
    // at 12 (`reviewer/gate.ts`). Also at least one, for the same reason.
    modelConcurrency: envNumber("LORE_MODEL_CONCURRENCY", DEFAULT_REVIEWER.modelConcurrency, 1),
    dailyCeilingUsd: envNumber("LORE_DAILY_CEILING_USD", DEFAULT_SPEND.dailyCeilingUsd),
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
  const reviewer = new Reviewer({ ...DEFAULT_REVIEWER, modelConcurrency: cfg.modelConcurrency });

  const worker = new Worker(
    store,
    { ...DEFAULT_WORKER, reposRoot, concurrency: cfg.concurrency },
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

  const http = startHttp(
    store,
    {
      store,
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
      enqueue: (reviewId, stage) => {
        // Checked before starting, never mid-review: killing a review halfway
        // leaves it neither passed nor honestly failed, and wastes what was spent.
        void mayStart(store, { ...DEFAULT_SPEND, dailyCeilingUsd: cfg.dailyCeilingUsd }, alerter).then((v) => {
          if (v.allowed) store.enqueue(reviewId, stage);
          else store.updateReview(reviewId, { state: "failed" });
        });
      },
      attest: async (reviewId) => {
        return render(await attest(store, reviewId, store.principalOf(reviewId) ?? "", keyPath));
      },
    },
    {
      port: cfg.port,
      host: cfg.host,
      heartbeat,
      spend: { ...DEFAULT_SPEND, dailyCeilingUsd: cfg.dailyCeilingUsd },
      modelGate: () => reviewer.gateState(),
    },
  );

  console.error(`lore listening on ${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`);

  return () => {
    http.close();
    clearInterval(sweep);
    stopBeat();
    stopWorker();
    store.close();
  };
}
