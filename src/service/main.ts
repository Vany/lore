/**
 * The service entry point: HTTP host, background workers, heartbeat.
 *
 * Everything is wired here so the wiring is in one readable place rather than
 * spread across modules that each know a little too much about the others.
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Alerter } from "../ops/alerts.ts";
import { DEFAULT_HEARTBEAT, startHeartbeat, type HeartbeatConfig } from "../ops/heartbeat.ts";
import { DEFAULT_RETENTION, collect } from "../ops/retention.ts";
import { DEFAULT_SPEND, mayStart } from "../ops/spend.ts";
import { repoPaths, worktreeFor } from "../git/repo.ts";
import { Store } from "../store/store.ts";
import { attest, render } from "./attest.ts";
import { startHttp } from "./http.ts";
import { DEFAULT_WORKER, Worker } from "./worker.ts";

export interface ServiceConfig {
  readonly dataDir: string;
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
    dataDir: env("LORE_DATA_DIR") ?? "/var/lib/lore",
    port: envNumber("LORE_PORT", 7777, 1),
    // Binds to the tailnet interface in production; 0.0.0.0 inside a container
    // that is only reachable through it.
    host: env("LORE_HOST") ?? "0.0.0.0",
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    ...(heartbeatUrl !== undefined ? { heartbeatUrl } : {}),
    ...(backupDir !== undefined ? { backupDir } : {}),
    // At least one: zero workers is a service that queues for ever in silence.
    concurrency: envNumber("LORE_CONCURRENCY", DEFAULT_WORKER.concurrency, 1),
    dailyCeilingUsd: envNumber("LORE_DAILY_CEILING_USD", DEFAULT_SPEND.dailyCeilingUsd),
  };
}

export async function serve(cfg: ServiceConfig): Promise<() => void> {
  await mkdir(cfg.dataDir, { recursive: true });
  const store = new Store(join(cfg.dataDir, "lore.db"));

  const alerter = new Alerter({
    ...(cfg.webhookUrl !== undefined ? { webhookUrl: cfg.webhookUrl } : {}),
    timeoutMs: 10_000,
  });

  const reposRoot = join(cfg.dataDir, "repos");
  const keyPath = join(cfg.dataDir, "attest_ed25519.pem");

  const worker = new Worker(
    store,
    { ...DEFAULT_WORKER, reposRoot, concurrency: cfg.concurrency },
    alerter,
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
        const row = store.db
          .prepare("SELECT r.branch, r.repo_id, p.git_url FROM review r JOIN repo p ON p.id = r.repo_id WHERE r.id = ?")
          .get(reviewId) as Record<string, string> | undefined;
        const paths = repoPaths(reposRoot, row?.["repo_id"] ?? "");
        return worktreeFor(paths, reviewId, row?.["branch"] ?? "", row?.["git_url"] ?? "");
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
        const row = store.db
          .prepare("SELECT principal FROM review WHERE id = ?")
          .get(reviewId) as Record<string, string> | undefined;
        return render(await attest(store, reviewId, row?.["principal"] ?? "", keyPath));
      },
    },
    {
      port: cfg.port,
      host: cfg.host,
      heartbeat,
      spend: { ...DEFAULT_SPEND, dailyCeilingUsd: cfg.dailyCeilingUsd },
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
