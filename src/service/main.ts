/**
 * The service entry point: HTTP host, background workers, heartbeat.
 *
 * Everything is wired here so the wiring is in one readable place rather than
 * spread across modules that each know a little too much about the others.
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Alerter } from "../ops/alerts.ts";
import { DEFAULT_HEARTBEAT, startHeartbeat } from "../ops/heartbeat.ts";
import { DEFAULT_RETENTION, collect } from "../ops/retention.ts";
import { DEFAULT_SPEND, mayStart } from "../ops/spend.ts";
import { addWorktree, repoPaths } from "../git/repo.ts";
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
  readonly runTests: boolean;
  readonly concurrency: number;
  readonly dailyCeilingUsd: number;
}

export function configFromEnv(): ServiceConfig {
  const env = process.env;
  return {
    dataDir: env["LORE_DATA_DIR"] ?? "/var/lib/lore",
    port: Number(env["LORE_PORT"] ?? 7777),
    // Binds to the tailnet interface in production; 0.0.0.0 inside a container
    // that is only reachable through it.
    host: env["LORE_HOST"] ?? "0.0.0.0",
    ...(env["LORE_WEBHOOK_URL"] !== undefined ? { webhookUrl: env["LORE_WEBHOOK_URL"] } : {}),
    ...(env["LORE_HEARTBEAT_URL"] !== undefined ? { heartbeatUrl: env["LORE_HEARTBEAT_URL"] } : {}),
    runTests: env["LORE_RUN_TESTS"] === "1",
    concurrency: Number(env["LORE_CONCURRENCY"] ?? DEFAULT_WORKER.concurrency),
    dailyCeilingUsd: Number(env["LORE_DAILY_CEILING_USD"] ?? DEFAULT_SPEND.dailyCeilingUsd),
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
    { ...DEFAULT_WORKER, reposRoot, runTests: cfg.runTests, concurrency: cfg.concurrency },
    alerter,
  );
  const stopWorker = worker.start();

  const stopBeat = startHeartbeat(
    store,
    {
      ...DEFAULT_HEARTBEAT,
      ...(cfg.heartbeatUrl !== undefined ? { url: cfg.heartbeatUrl } : {}),
      dataDir: cfg.dataDir,
    },
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
      worktreeFor: async (reviewId) => {
        const row = store.db
          .prepare("SELECT repo_id, branch FROM review WHERE id = ?")
          .get(reviewId) as Record<string, string> | undefined;
        const paths = repoPaths(reposRoot, row?.["repo_id"] ?? "");
        return addWorktree(paths, reviewId, row?.["branch"] ?? "").catch(
          () => join(paths.worktrees, reviewId),
        );
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
    { port: cfg.port, host: cfg.host, heartbeat: { ...DEFAULT_HEARTBEAT, dataDir: cfg.dataDir } },
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
