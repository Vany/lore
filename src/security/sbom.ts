/**
 * What we are actually shipping.
 *
 * A security review asks a different question from a code review — *what
 * known-vulnerable things are in this tree, and can they be reached?* — and it
 * needs a different input: the dependency graph, not the diff.
 *
 * CycloneDX via `cdxgen` when it is installed, and a lockfile reader when it is
 * not. The fallback matters: a security review that silently does not run because a
 * tool was missing is the worst possible version of INV-1, since the thing it would
 * have told you about is a published vulnerability.
 *
 * SPEC: research/security-review.md §4.1
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runTool } from "../t0/exec.ts";

/** OSV ecosystem names. Only what this workgroup ships, plus the obvious neighbours. */
export type Ecosystem = "npm" | "PyPI" | "Go" | "crates.io" | "Maven" | "RubyGems";

export interface Component {
  readonly name: string;
  readonly version: string;
  readonly ecosystem: Ecosystem;
  /** True when nothing in the project imports it directly. */
  readonly transitive: boolean;
}

export interface Sbom {
  readonly components: readonly Component[];
  readonly source: "cdxgen" | "package-lock" | "none";
  readonly note?: string;
}

interface CycloneDxDoc {
  components?: { name?: string; version?: string; purl?: string; scope?: string }[];
}

export async function generateSbom(worktree: string): Promise<Sbom> {
  const viaCdxgen = await cdxgen(worktree);
  if (viaCdxgen !== undefined) return viaCdxgen;

  const viaLock = await fromPackageLock(worktree);
  if (viaLock !== undefined) return viaLock;

  return {
    components: [],
    source: "none",
    // Said out loud rather than returned as an empty list. "No components found"
    // and "we could not look" must never be the same answer.
    note: "no SBOM could be produced — cdxgen is not installed and no package-lock.json was found",
  };
}

async function cdxgen(worktree: string): Promise<Sbom | undefined> {
  const r = await runTool(
    worktree,
    "npx",
    ["--no-install", "@cyclonedx/cdxgen", "-o", "/dev/stdout", "--spec-version", "1.6"],
    300_000,
  );
  if (r.unavailable !== undefined || !r.ok) return undefined;

  const start = r.stdout.indexOf("{");
  if (start < 0) return undefined;
  try {
    const doc = JSON.parse(r.stdout.slice(start)) as CycloneDxDoc;
    const components = (doc.components ?? [])
      .map((c) => toComponent(c.name, c.version, c.purl, c.scope))
      .filter((c): c is Component => c !== undefined);
    return { components, source: "cdxgen" };
  } catch {
    return undefined;
  }
}

interface LockV3 {
  packages?: Record<string, { version?: string; dev?: boolean; link?: boolean }>;
}

/**
 * npm lockfile v2/v3.
 *
 * Keys look like `node_modules/foo` or `node_modules/a/node_modules/b`; the last
 * segment after the final `node_modules/` is the package name, which is also how
 * scoped names survive intact.
 */
async function fromPackageLock(worktree: string): Promise<Sbom | undefined> {
  const raw = await readFile(join(worktree, "package-lock.json"), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;

  let doc: LockV3;
  try {
    doc = JSON.parse(raw) as LockV3;
  } catch {
    return undefined;
  }

  const components: Component[] = [];
  const seen = new Set<string>();

  for (const [path, entry] of Object.entries(doc.packages ?? {})) {
    if (path === "" || entry.link === true || entry.version === undefined) continue;
    const marker = path.lastIndexOf("node_modules/");
    if (marker < 0) continue;

    const name = path.slice(marker + "node_modules/".length);
    const key = `${name}@${entry.version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    components.push({
      name,
      version: entry.version,
      ecosystem: "npm",
      // Depth in the path is the only signal a lockfile gives about directness.
      transitive: path.split("node_modules/").length > 2,
    });
  }

  return {
    components,
    source: "package-lock",
    note: "cdxgen not available; read package-lock.json directly. Dev/prod scope is not distinguished.",
  };
}

function toComponent(
  name: string | undefined,
  version: string | undefined,
  purl: string | undefined,
  scope: string | undefined,
): Component | undefined {
  if (name === undefined || version === undefined) return undefined;
  return {
    name,
    version,
    ecosystem: ecosystemOf(purl) ?? "npm",
    transitive: scope === "optional" || scope === undefined,
  };
}

function ecosystemOf(purl: string | undefined): Ecosystem | undefined {
  if (purl === undefined) return undefined;
  const m = /^pkg:([a-z.]+)\//.exec(purl);
  switch (m?.[1]) {
    case "npm":
      return "npm";
    case "pypi":
      return "PyPI";
    case "golang":
      return "Go";
    case "cargo":
      return "crates.io";
    case "maven":
      return "Maven";
    case "gem":
      return "RubyGems";
    default:
      return undefined;
  }
}
