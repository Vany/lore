/**
 * A database that cannot be read must not take the service down silently.
 *
 * On 2026-08-08 it did. `reclaimOrphanedJobs` threw at startup, the process exited 70,
 * Docker restarted it, and that loop would have run for ever — `/status`, the one
 * endpoint whose purpose is answering *am I healthy*, refusing connections the whole
 * time. From outside, that is indistinguishable from the machine being off.
 *
 * The heartbeat had been taught to check integrity the day before, after the same fault
 * went unnoticed for twenty minutes. It was no use, and the reason is the one this file
 * exists to keep fixed: **a check only runs while the service is healthy enough to run
 * it.** So the check moves to startup, and a failure serves a refusal instead of dying.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { serve } from "./main.ts";
import { refusalText } from "./refusing.ts";

let dir: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-refusing-"));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Damage a real database the way the disk does, with the Store still open.
 *
 * Zeroing the header instead makes SQLite refuse to OPEN the file, which is a different
 * failure that the constructor already reports — an earlier version of this fixture did
 * exactly that and proved nothing about the case that actually happened, where the open
 * succeeds and the damage is in a tree nothing has touched yet.
 */
function corrupt(dataDir: string): void {
  const store = new Store(join(dataDir, "lore.db"));
  const repo = store.upsertRepo("demo", "git@example.com:demo.git");
  // Enough rows that the knowledge tree spans several pages, so damaging one page
  // damages a b-tree rather than free space.
  for (let i = 0; i < 400; i++) {
    store.addKnowledge({
      repoId: repo.id, kind: "rule", source: "taught",
      statement: `rule number ${String(i)} with enough text to take real space on a page`,
      why: "so the tree spans pages", path: undefined, cwe: undefined,
      provenance: "fixture", sourceBlob: undefined, confidence: 1,
    });
  }
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();

  const path = join(dataDir, "lore.db");
  const bytes = readFileSync(path);
  // A data page, well past the header, filled with something that is not a valid page.
  const PAGE = 4096;
  for (let p = 20; p < 40; p++) bytes.fill(0x5a, p * PAGE, (p + 1) * PAGE);
  writeFileSync(path, bytes);
}

const cfg = (dataDir: string, port: number) => ({
  dataDir,
  port,
  host: "127.0.0.1",
  concurrency: 1,
  modelConcurrency: 1,
  allowMetered: false,
});

describe("a service whose database is unreadable", () => {
  it("stays up and answers /status with the fault and the remedy", async () => {
    corrupt(dir);

    // It must NOT throw. Throwing here is the crash-loop, and the crash-loop is the bug.
    stop = await serve(cfg(dir, 17781));

    // lore-ok[8f44300f]: rule de7fb2b3 — this is the test's own server, bound to
    // 127.0.0.1 on an ephemeral port moments earlier by the line above, and spoken to
    // from the same process. There is no transport to encrypt. Serving it over TLS would
    // mean a certificate fixture for every test that checks an HTTP contract, to defend
    // a loopback socket against nothing.
    const res = await fetch("http://127.0.0.1:17781/status");
    expect(res.status, "503, so a monitor sees a failure without parsing the body").toBe(503);
    const body = (await res.json()) as { ok: boolean; problems: string[]; serving: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.serving).toBe(false);
    // The SAME key the healthy path uses. A monitor watching `problems` must not need
    // to be taught a second shape for the one fault that ends the service.
    expect(body.problems.join(" ")).toMatch(/DATABASE UNREADABLE/);
    expect(body.detail).toMatch(/make restore/);
  });

  // A client that gets 200 with an error body will often carry on. Everything refuses.
  it("refuses MCP rather than serving a broken one", async () => {
    corrupt(dir);
    stop = await serve(cfg(dir, 17782));

    const res = await fetch("http://127.0.0.1:17782/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/cannot be read/);
  });

  /**
   * A DIRECTORY THAT DOES NOT EXIST YET IS A FRESH INSTALL, NOT A CORRUPTION.
   *
   * `serve()` created `dataDir` and not `dbDir`, which stopped being the same directory
   * when the database moved to its own volume. So `new Store()` threw on a path that had
   * simply never been made, `openOrRefuse` classified the throw as corruption, and the
   * service refused to serve — telling the operator to run `make backup-check` and
   * `make restore` on a box with no backup and nothing to restore, and refusing to retry
   * once the directory appeared.
   *
   * The most innocent state in the system, answered with its gravest message, by the
   * guard written to make grave states legible.
   */
  it("creates a database directory that does not exist rather than calling it corrupt", async () => {
    const cfgWithDbDir = { ...cfg(dir, 17784), dbDir: join(dir, "never-made", "db") };
    stop = await serve(cfgWithDbDir);
    const res = await fetch("http://127.0.0.1:17784/status");
    expect(res.status, "a fresh install must serve, not refuse").toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  // The healthy path must be untouched: this is a guard, not a new mode to fall into.
  it("serves normally when the database is fine", async () => {
    execFileSync("mkdir", ["-p", join(dir, "repos")]);
    stop = await serve(cfg(dir, 17783));
    const res = await fetch("http://127.0.0.1:17783/status");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("the refusal text", () => {
  // Read by a person running curl AND by an agent that repeats it to its user, so it has
  // to carry the three things either of them needs: what is wrong, what it means for the
  // reviews, and what to do. Checked because the message IS the feature.
  it("says what is wrong, what it means, and what to do", () => {
    const text = refusalText({ port: 1, bind: "x", dbPath: "/data/lore.db", fault: "disk image is malformed" });
    expect(text).toContain("disk image is malformed");
    expect(text).toContain("/data/lore.db");
    expect(text, "a review that did not run is not a review that found nothing").toMatch(
      /none of them\s+passed, and none of them found nothing/,
    );
    expect(text).toContain("make restore");
    expect(text, "the operator must not wait for a self-heal that is not coming").toMatch(/will not retry/);
  });
});
