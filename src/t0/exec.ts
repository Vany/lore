/**
 * Running the target repo's tooling.
 *
 * Non-zero exit is the normal case here — a linter that finds something exits 1 —
 * so unlike git, failure is data rather than an error. What is *not* normal is a
 * tool that cannot be run at all, and that is reported rather than treated as
 * "found nothing" (INV-1).
 */

import { execFile } from "node:child_process";
import { constants } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A process a SIGNAL killed did not exit — Node reports the signal's NAME
 * (`err.signal`, e.g. `"SIGKILL"`), never a number, and `err.code` in that case is
 * `null`/`undefined`, not the POSIX `128 + signal` exit code a shell would report.
 *
 * Found by lore's own review, fingerprint 88fccc85/fdf8a29e/1b65dcdd: every `code
 * === 137` check downstream (t0/engines.ts, t0/runner.ts) assumed the shell
 * convention — true for `docker run`, which translates a killed CONTAINER into
 * its OWN ordinary exit code, but never true for a bare host binary (semgrep,
 * ast-grep) an OOM-killer signals directly. Translated here, once, to the
 * convention every downstream check already assumes, rather than teaching each
 * of them a second way to recognise the same fact.
 */
function signalToCode(signal: NodeJS.Signals | null | undefined): number | undefined {
  if (signal === null || signal === undefined) return undefined;
  const num = (constants.signals as Record<string, number | undefined>)[signal];
  return num === undefined ? undefined : 128 + num;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the tool could not be executed at all — missing binary, crash. */
  readonly unavailable?: string;
}

/**
 * Run a tool in the target repo.
 *
 * The timeout is mandatory, not defensive: on the deployment host T0 is the
 * throughput bottleneck (D-37), and a hung tool holding a review slot forever
 * looks like a slow review rather than a stuck one.
 *
 * TOOLS INHERIT NO AMBIENT CREDENTIALS BY DEFAULT — now actually true, not just
 * claimed. `env: { ...process.env, ... }` used to hand semgrep, ast-grep and
 * `cdxgen` (invoked via `npx` from `security/sbom.ts`) the SERVICE's full
 * environment, `LORE_WEBHOOK_URL` (a credential per SPEC.md §"never rendered")
 * included, while those processes parsed a reviewed repository's own untrusted
 * config and dependency tree. Found by lore's own review, fingerprint 72871cca.
 *
 * `inheritHostEnv: true` is the one deliberate exception: `runInSandbox`/`install`
 * (`sandbox.ts`) call this to run `docker` ITSELF, a trusted host binary that
 * orchestrates the sandbox rather than reading the reviewed content — it
 * genuinely needs the ambient environment to reach the daemon (`DOCKER_HOST`, its
 * own `HOME`-relative config), and the CONTAINER it launches gets its own
 * separately-constructed, already-minimal `-e` list regardless (`baseArgs`), so
 * this exception never reaches the untrusted target's own execution environment.
 */
export async function runTool(
  cwd: string,
  cmd: string,
  args: readonly string[],
  timeoutMs = 300_000,
  inheritHostEnv = false,
): Promise<ToolResult> {
  try {
    const base = inheritHostEnv
      ? process.env
      : { PATH: process.env["PATH"], HOME: process.env["HOME"] };
    const { stdout, stderr } = await run(cmd, [...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
      env: { ...base, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return { ok: true, code: 0, stdout, stderr, timedOut: false };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    // ENOENT means the tool is not installed. That is not a clean result — it is a
    // check that did not run, and the caller must say so out loud.
    if (err.code === "ENOENT") {
      return { ok: false, code: -1, stdout: "", stderr: "", timedOut: false, unavailable: `${cmd} not found` };
    }
    const timedOut = err.killed === true;
    return {
      ok: false,
      code: typeof err.code === "number" ? err.code : (signalToCode(err.signal) ?? 1),
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      timedOut,
      ...(timedOut ? { unavailable: `${cmd} timed out after ${timeoutMs}ms` } : {}),
    };
  }
}
