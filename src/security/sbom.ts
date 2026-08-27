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
  /**
   * lore-ok[c0b4887e]: True when nothing in the project imports it directly,
   * false when something does, `undefined` when depth genuinely is not known.
   *
   * `cdxgen`'s own flat `components[]` list carries no depth signal — CycloneDX's
   * `scope` field (`required`/`optional`/`excluded`) describes whether a component
   * SHIPS, not whether it is direct or transitive, and the real answer lives in a
   * separate `dependencies` graph this reader does not parse (unverified whether
   * `cdxgen` reliably populates it at all, and there is no local instance of the
   * tool to check against). `undefined` here says so rather than guessing from a
   * field that means something else. `fromPackageLock` below has a REAL signal
   * (path depth in the lockfile) and keeps reporting a true boolean. The same
   * finding also covers two related but separate misreadings: `toComponent`
   * defaulting an unrecognised purl to npm instead of refusing it (below), and
   * `TYPICAL_MANIFEST` (osv.ts) hardcoding one lockfile name for every ecosystem.
   */
  readonly transitive: boolean | undefined;
}

export interface Sbom {
  readonly components: readonly Component[];
  readonly source: "cdxgen" | "package-lock" | "none";
  /**
   * Informational — a caveat about the METHOD, true on every run that used it
   * (e.g. "cdxgen not available; read package-lock.json directly"). Never a
   * completeness signal: `fromPackageLock` sets it unconditionally, so a caller
   * that surfaced it as `unavailable` would report every single fallback-path
   * review as "NOT RUN" — the exact ast-grep-shaped noise this module's own
   * caller (`engines.ts`) exists to avoid, except actively false here since the
   * enumeration did run. See `incomplete` for the signal that means that.
   */
  readonly note?: string;
  /**
   * Set only when some real, specific subset of what should have been enumerated
   * was not — count varies per review, same shape as semgrep's `unread`
   * (engines.ts). This one IS worth a caller surfacing as a gap.
   */
  readonly incomplete?: string;
}

interface CycloneDxDoc {
  components?: { name?: string; version?: string; purl?: string }[];
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
    const raw = doc.components ?? [];
    const components = raw
      .map((c) => toComponent(c.name, c.version, c.purl))
      .filter((c): c is Component => c !== undefined);
    // DROPPED, NOT MISQUERIED (see Component.transitive's own doc comment, above,
    // for the finding this answers). `toComponent` now refuses a component whose
    // purl names an ecosystem outside the six this module queries (or one it
    // cannot parse at all), rather than defaulting it to "npm" and having OSV
    // answer an authoritative-looking "nothing known" for a package it was never
    // actually asked about. Disclosed by count here, since which of the two
    // reasons applied to which entry is not worth carrying further than this
    // note — either way, it was not checked.
    const dropped = raw.length - components.length;
    return {
      components,
      source: "cdxgen",
      ...(dropped > 0
        ? {
            incomplete:
              `${String(dropped)} of ${String(raw.length)} component(s) had no name/version, or a purl naming an ` +
              "ecosystem this module does not query (only npm, PyPI, Go, crates.io, Maven, RubyGems) — not checked " +
              "against OSV.",
          }
        : {}),
    };
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
): Component | undefined {
  if (name === undefined || version === undefined) return undefined;
  // REFUSED, NOT DEFAULTED TO "npm" (see Component.transitive's own doc comment,
  // above, for the finding this answers). A purl naming an ecosystem this module
  // does not recognise (or carrying none at all) used to fall back to "npm", so
  // `queryComponents` (osv.ts) asked OSV about, say, a Composer package under
  // the npm ecosystem — a query OSV answers with an authoritative-looking
  // "nothing known", which is not the same claim as "not checked" and is
  // exactly the confident-false-clean INV-1 exists to name. The caller
  // (`cdxgen`, above) counts and discloses drops.
  const ecosystem = ecosystemOf(purl);
  if (ecosystem === undefined) return undefined;
  return {
    name,
    version,
    ecosystem,
    // `scope` (CycloneDX: required/optional/excluded, whether a component SHIPS)
    // is not a depth signal and was never a sound way to answer "direct or
    // transitive" — see `Component.transitive`'s own doc comment. `undefined`
    // here is honest about not knowing, not a guess dressed as one.
    transitive: undefined,
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
