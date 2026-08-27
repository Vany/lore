import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_MAX } from "../core/finding.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import {
  commitToFindings,
  fixedVersion,
  queryCommit,
  queryComponents,
  severityOf,
  toFindings,
  type OsvVuln,
} from "./osv.ts";
import { generateSbom, type Component } from "./sbom.ts";
import { buildVex, findingsNeedingTriage, justificationFor, stateFor, vulnIdOf, renderVex, vexGap, type VexDocument } from "./vex.ts";

const component: Component = { name: "lodash", version: "4.17.20", ecosystem: "npm", transitive: true };

const vuln: OsvVuln = {
  id: "GHSA-xxxx-yyyy-zzzz",
  summary: "prototype pollution in defaultsDeep",
  aliases: ["CVE-2020-8203"],
  database_specific: { severity: "HIGH", cwe_ids: ["CWE-1321"] },
  affected: [{ ranges: [{ events: [{ fixed: "4.17.21" }] }] }],
};

/**
 * `generateSbom` prefers cdxgen and falls back to reading package-lock.json
 * directly; `npx` is faked on PATH so these do not depend on cdxgen actually
 * being installed on whatever machine runs the suite.
 */
describe("generateSbom", () => {
  let dir: string;
  let binDir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-sbomgen-"));
    binDir = mkdtempSync(join(tmpdir(), "lore-sbomgen-bin-"));
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}:${savedPath ?? ""}`;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  // Fingerprint 02811eb9: npm ≤6's package-lock.json (lockfileVersion 1) has no
  // "packages" key at all — deps live under nested "dependencies" instead, a
  // shape this reader was never written to walk. `Object.entries(undefined ??
  // {})` used to read that identically to a real, empty v2/v3 lockfile.
  it("discloses a lockfileVersion-1 lockfile as unread, not as zero dependencies", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(binDir, "npx"), 0o755);
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 1, dependencies: { lodash: { version: "4.17.21" } } }),
    );
    const sbom = await generateSbom(dir);
    expect(sbom.components).toStrictEqual([]);
    expect(sbom.incomplete).toMatch(/lockfileVersion 1/);
  });

  // Fingerprint e10c3847: a present-but-malformed package-lock.json (a merge
  // conflict left unresolved is routine input for a review tool) used to
  // return the same `undefined` as the file not existing at all, so the
  // note said "(not found)" about a file that is right there.
  it("discloses a malformed package-lock.json as unparseable, not as missing", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(binDir, "npx"), 0o755);
    writeFileSync(join(dir, "package-lock.json"), "<<<<<<< HEAD\nnot json\n=======\n");
    const sbom = await generateSbom(dir);
    expect(sbom.source).toBe("package-lock");
    expect(sbom.incomplete).toMatch(/did not parse as JSON/);
  });

  // Fingerprint fc100d52: JSON.parse succeeds on `null` without throwing —
  // the e10c3847 fix's own try/catch never sees it, and reading .packages
  // off null used to throw an UNCAUGHT TypeError that escaped this function
  // entirely, failing the whole t0 round instead of producing a disclosure.
  it("discloses valid-JSON-but-not-an-object as unreadable, without crashing the round", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(binDir, "npx"), 0o755);
    writeFileSync(join(dir, "package-lock.json"), "null");
    const sbom = await generateSbom(dir);
    expect(sbom.source).toBe("package-lock");
    expect(sbom.incomplete).toMatch(/not the expected object shape/);
  });

  // `{"packages": null}` hits the identical TypeError one field deeper —
  // JSON.parse succeeds, doc itself is a valid object, but .packages being
  // explicitly null still throws on Object.entries(null).
  it("discloses a null packages field as unreadable, without crashing the round", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(binDir, "npx"), 0o755);
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: null }));
    const sbom = await generateSbom(dir);
    expect(sbom.source).toBe("package-lock");
    expect(sbom.incomplete).toMatch(/not the expected object shape/);
  });

  // A real, empty v2/v3 lockfile (a project with genuinely zero dependencies)
  // must NOT trip the same disclosure — `packages: {}` is a known, complete
  // answer, not an unreadable one.
  it("does not treat a genuinely empty v2/v3 lockfile as unread", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(binDir, "npx"), 0o755);
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const sbom = await generateSbom(dir);
    expect(sbom.components).toStrictEqual([]);
    expect(sbom.incomplete).toBeUndefined();
  });

  // Fingerprint 2fc96d80: OSV's own schema requires Maven package.name to be
  // "groupId:artifactId" — a bare artifactId is generally not a package OSV
  // has ever heard of, so every Maven query silently missed.
  it("names a Maven component groupId:artifactId, not the bare artifactId", async () => {
    const cdxgenOutput = JSON.stringify({
      components: [
        { name: "log4j-core", version: "2.17.1", purl: "pkg:maven/org.apache.logging.log4j/log4j-core@2.17.1" },
      ],
    });
    writeFileSync(join(binDir, "npx"), `#!/bin/sh\necho '${cdxgenOutput}'\nexit 0\n`);
    chmodSync(join(binDir, "npx"), 0o755);
    const sbom = await generateSbom(dir);
    expect(sbom.components[0]?.name).toBe("org.apache.logging.log4j:log4j-core");
  });

  // Fingerprint af39c6f5: a cdxgen that is genuinely absent and a cdxgen that
  // is present but crashes on a manifest it cannot parse used to produce the
  // identical "cdxgen is not installed" sentence — sending an operator to
  // reinstall a tool that was never the problem.
  it("reports a cdxgen crash as a crash, not as 'not installed'", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\necho 'cdxgen: cannot parse pom.xml: bad token' >&2\nexit 1\n");
    chmodSync(join(binDir, "npx"), 0o755);
    const sbom = await generateSbom(dir);
    expect(sbom.note).toMatch(/did not produce a usable SBOM/);
    expect(sbom.note).toMatch(/cannot parse pom\.xml/);
    expect(sbom.note).not.toMatch(/not installed/);
  });

  // Fingerprint cab708e4: the af39c6f5 fix only split the `!r.ok` (non-zero
  // exit) branch — a cdxgen that exits 0 but writes no JSON at all, or writes
  // something that does not parse, is ALSO not "absent" and used to fall
  // through to the identical false "not installed" sentence.
  it("does not say 'not installed' when cdxgen exits 0 with no JSON on stdout", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\necho 'unexpected warning, no bom emitted'\nexit 0\n");
    chmodSync(join(binDir, "npx"), 0o755);
    const sbom = await generateSbom(dir);
    expect(sbom.note).toMatch(/did not produce a usable SBOM/);
    expect(sbom.note).not.toMatch(/not installed/);
  });

  it("does not say 'not installed' when cdxgen's output does not parse as JSON", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\necho '{not valid json'\nexit 0\n");
    chmodSync(join(binDir, "npx"), 0o755);
    const sbom = await generateSbom(dir);
    expect(sbom.note).toMatch(/did not produce a usable SBOM/);
    expect(sbom.note).not.toMatch(/not installed/);
  });

  // `npx --no-install <real, existing package not locally cached>` was verified
  // empirically (this session, on a real npm install) to exit 0 with the npm
  // error on stderr and nothing on stdout, the SAME shape cab708e4's fix
  // above now (correctly) reports as "did not produce a usable SBOM" rather
  // than presuming absence — genuine absence is a live possibility for that
  // exact shape too, on a different npm version or network condition, and
  // claiming to know which is exactly the guess INV-1 forbids. Only a true
  // ENOENT (npx itself unresolvable) still says "not installed", since that
  // is the one case this reader can actually confirm.
  it("still says 'not installed' when npx itself cannot be found at all", async () => {
    process.env["PATH"] = binDir; // no fallback: npx must not resolve anywhere
    const sbom = await generateSbom(dir);
    expect(sbom.note).toMatch(/not installed/);
    expect(sbom.note).not.toMatch(/did not produce a usable SBOM/);
  });

  // Fingerprint b03d0b1e: detect()'s own widening means this "none" bucket
  // is now reachable on repos that never had a package-lock.json to begin
  // with — the note must blame this reader's own npm-only fallback, not the
  // repo, for a file it never needed.
  it("blames its own npm-only fallback, not the repo, when nothing is found", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(binDir, "npx"), 0o755);
    const sbom = await generateSbom(dir);
    expect(sbom.note).toMatch(/this reader's own fallback only understands npm/);
  });

  // Fingerprint f4b810d9: exec.ts sets `r.unavailable` for BOTH a missing
  // binary AND a run that hit its timeout — a cdxgen that is genuinely
  // installed and just slow on a large tree is not "not installed" either.
  // `cdxgenTimeoutMs` exists so this does not have to wait out a real 300s.
  it("does not say 'not installed' when cdxgen times out", async () => {
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\nsleep 2\n");
    chmodSync(join(binDir, "npx"), 0o755);
    const sbom = await generateSbom(dir, 50);
    expect(sbom.note).toMatch(/timed out/);
    expect(sbom.note).not.toMatch(/^no SBOM could be produced — cdxgen is not installed/);
  });
});

describe("severityOf", () => {
  it("maps the database's own rating", () => {
    expect(severityOf({ id: "a", database_specific: { severity: "CRITICAL" } })).toBe("high");
    expect(severityOf({ id: "a", database_specific: { severity: "MODERATE" } })).toBe("medium");
    expect(severityOf({ id: "a", database_specific: { severity: "LOW" } })).toBe("low");
  });

  // An unrated vulnerability is unrated, not harmless. Defaulting downward is how
  // things stop being looked at.
  it("treats an unrated vulnerability as medium, not low", () => {
    expect(severityOf({ id: "a" })).toBe("medium");
  });
});

describe("fixedVersion", () => {
  it("finds the fix when one is published", () => {
    expect(fixedVersion(vuln, component)).toStrictEqual(["4.17.21"]);
  });

  it("returns nothing when no fix exists, rather than inventing one", () => {
    expect(fixedVersion({ id: "a", affected: [{ ranges: [{ events: [] }] }] }, component)).toStrictEqual([]);
  });

  // Multi-package advisories are real (OSV schema §affected[]) — an entry naming a
  // DIFFERENT package must not contribute its fix version to this one.
  it("ignores an affected entry naming a different package", () => {
    const other: OsvVuln = {
      id: "a",
      affected: [{ package: { name: "not-lodash", ecosystem: "npm" }, ranges: [{ events: [{ fixed: "9.9.9" }] }] }],
    };
    expect(fixedVersion(other, component)).toStrictEqual([]);
  });

  // A vulnerability with two separate vulnerable ranges (e.g. an old 1.x line and a
  // newer 3.x line) can have two distinct fixes, and picking one arbitrarily hides
  // the other from whichever range the installed version is actually in.
  it("returns every distinct fix when a vulnerability has multiple ranges", () => {
    const multi: OsvVuln = {
      id: "a",
      affected: [
        {
          package: { name: component.name, ecosystem: component.ecosystem },
          ranges: [{ events: [{ fixed: "1.0.2" }] }, { events: [{ fixed: "3.2.5" }] }],
        },
      ],
    };
    expect(fixedVersion(multi, component)).toStrictEqual(["1.0.2", "3.2.5"]);
  });
});

describe("toFindings", () => {
  it("anchors the finding to the lockfile, where the decision actually lives", () => {
    const [f] = toFindings([{ component, vulns: [vuln] }]);
    expect(f?.file).toBe("package-lock.json");
    expect(f?.severity).toBe("high");
    expect(f?.cwe).toBe("CWE-1321");
  });

  it("names the CVE rather than the internal id, because that is what people search", () => {
    const [f] = toFindings([{ component, vulns: [vuln] }]);
    expect(f?.claim).toContain("CVE-2020-8203");
    expect(f?.claim).toContain("lodash@4.17.20");
  });

  it("records whether the dependency is direct, since it changes what a fix costs", () => {
    const [f] = toFindings([{ component, vulns: [vuln] }]);
    expect(f?.evidence).toContain("transitively");
    expect(f?.evidence).toContain("fixed in 4.17.21");
  });

  it("produces findings that satisfy the finding schema's caps", () => {
    const wordy: OsvVuln = { ...vuln, summary: "x".repeat(600), details: "y".repeat(5000) };
    const [f] = toFindings([{ component, vulns: [wordy] }]);
    expect((f?.claim ?? "").length).toBeLessThanOrEqual(CLAIM_MAX);
    expect((f?.failureScenario ?? "").length).toBeLessThanOrEqual(2000);
  });

  // Fingerprint 324ff769: `file` is documented and consumed as a repo-relative
  // PATH (core/finding.ts, buildVex's affects[].ref) — PyPI's ambiguity between
  // requirements.txt/poetry.lock/Pipfile.lock belongs in `evidence`, which is
  // free text, not smuggled into the path field as a sentence no path-consumer
  // could ever resolve.
  it("gives a PyPI finding a real path, with the ambiguity disclosed in evidence instead", () => {
    const pypiComponent: Component = { name: "django", version: "3.0.0", ecosystem: "PyPI", transitive: false };
    const [f] = toFindings([{ component: pypiComponent, vulns: [vuln] }]);
    expect(f?.file).toBe("requirements.txt");
    expect(f?.file).not.toContain(" ");
    expect(f?.evidence).toContain("poetry.lock");
  });

  // Fingerprint 59c1cbc2: cdxgen enumerates npm-ecosystem components from
  // yarn.lock/pnpm-lock.yaml/bun.lock just as readily as from
  // package-lock.json — presenting "package-lock.json" as fact rather than a
  // typical guess is the same nonexistent-path shape PyPI already discloses.
  it("discloses the same package-lock.json ambiguity for npm", () => {
    const [f] = toFindings([{ component, vulns: [vuln] }]);
    expect(f?.file).toBe("package-lock.json");
    expect(f?.evidence).toContain("yarn.lock");
  });
});

/**
 * Real OSV separates matching from reading: `/querybatch` answers bare
 * `{id, modified}` per vuln, `/vulns/{id}` is the one endpoint with the full
 * record. A fake that answers the same body to both hides exactly the bug
 * fingerprint bfa2e44b named — this discriminates by URL so a test that
 * cares about hydrated content actually exercises it, rather than passing
 * by accident because a blanket fake answered anything successfully.
 */
function fakeOsvApi(querybatchBody: unknown, hydrate: (id: string) => OsvVuln = (id) => ({ id })): typeof fetch {
  return (async (url: string | URL) => {
    const href = typeof url === "string" ? url : url.href;
    const vulnsMatch = /\/vulns\/([^/?]+)/.exec(href);
    if (vulnsMatch?.[1] !== undefined) {
      return new Response(JSON.stringify(hydrate(decodeURIComponent(vulnsMatch[1]))), { status: 200 });
    }
    return new Response(JSON.stringify(querybatchBody), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("queryComponents", () => {
  it("returns only the components that matched", async () => {
    const fake = fakeOsvApi({ results: [{ vulns: [{ id: vuln.id }] }, {}] }, () => vuln);
    const out = await queryComponents([component, { ...component, name: "safe-pkg" }], fake);
    expect(out).toHaveLength(1);
    expect(out[0]?.component.name).toBe("lodash");
  });

  // THE ANSWERS ARE MATCHED TO THE QUERIES BY POSITION AND NOTHING ELSE. A short
  // response left the trailing components with no result, and they were reported as
  // CLEAN — not "we could not check" — in a security review, for packages nobody
  // looked at. INV-1 inside the scanner.
  it("refuses a batch whose answers do not line up with its questions", async () => {
    const short = fakeOsvApi({ results: [{ vulns: [{ id: vuln.id }] }] });
    await expect(
      queryComponents([component, { ...component, name: "unchecked-pkg" }], short),
    ).rejects.toThrow(/DID NOT RUN/);
  });

  it("says how many answers it got for how many questions", async () => {
    const short = fakeOsvApi({ results: [] });
    await expect(queryComponents([component], short)).rejects.toThrow(/0 result\(s\) for 1 component\(s\)/);
  });

  // A database we could not reach is NOT a database that said "clean". Returning
  // an empty list here would ship a known-vulnerable tree under a green result.
  it("throws when OSV is unreachable rather than reporting nothing found", async () => {
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(queryComponents([component], dead)).rejects.toThrow(/DID NOT RUN/);
  });

  it("throws on a non-200 rather than treating the body as a result", async () => {
    const bad = (async () => new Response("upstream error", { status: 503 })) as unknown as typeof fetch;
    await expect(queryComponents([component], bad)).rejects.toThrow(/DID NOT RUN/);
  });

  // Fingerprint bfa2e44b: /v1/querybatch's own docs say it "returns
  // vulnerability ids and modified field only" — every OTHER field a real
  // finding needs (summary, database_specific.severity, affected, aliases)
  // comes back undefined unless a caller separately hydrates each id.
  it("hydrates querybatch's bare {id, modified} results into full records", async () => {
    const fake = fakeOsvApi({ results: [{ vulns: [{ id: vuln.id, modified: "2024-01-01T00:00:00Z" }] }] }, () => vuln);
    const out = await queryComponents([component], fake);
    expect(out[0]?.vulns[0]?.summary).toBe(vuln.summary);
    expect(out[0]?.vulns[0]?.database_specific?.severity).toBe("HIGH");
    expect(out[0]?.vulns[0]?.aliases).toEqual(vuln.aliases);
  });

  it("throws rather than reporting a partially-hydrated result when hydration fails", async () => {
    const fake = (async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.href;
      if (/\/vulns\//.test(href)) return new Response("upstream error", { status: 503 });
      return new Response(JSON.stringify({ results: [{ vulns: [{ id: vuln.id }] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(queryComponents([component], fake)).rejects.toThrow(/DID NOT RUN/);
  });

  // Fingerprint bfa2e44b: a `next_page_token` on a result means OSV
  // truncated that component's own vulnerability list (over 1000 known
  // vulnerabilities) — the same silent-partial-result shape the
  // batch-length check already refuses, one component deeper.
  it("refuses a truncated per-component result rather than reporting it as complete", async () => {
    const fake = fakeOsvApi({ results: [{ vulns: [{ id: vuln.id }], next_page_token: "abc" }] });
    await expect(queryComponents([component], fake)).rejects.toThrow(/DID NOT RUN/);
  });
});

// THE HALF THAT WAS NEVER CALLED. `queryCommit` shipped with Phase 5, was tested,
// and had no caller until 2026-08-06 — so on a repository that vendors by submodule,
// which is how this workgroup ships (D-36), the security review enumerated the
// lockfile and reported clean about a tree it never queried.
describe("submodules are queried by commit", () => {
  const commit = "a".repeat(40);

  it("names the gitlink path, not the lockfile, because that is where the fix goes", () => {
    const [f] = commitToFindings("vendor/pay", commit, [vuln]);
    expect(f?.file).toBe("vendor/pay");
    expect(f?.evidence).toContain(commit);
    expect(f?.evidence).toMatch(/no package version/);
  });

  it("obeys the same caps as a package finding", () => {
    const wordy: OsvVuln = { ...vuln, summary: "x".repeat(600), details: "y".repeat(5000) };
    const [f] = commitToFindings("vendor/pay", commit, [wordy]);
    expect((f?.claim ?? "").length).toBeLessThanOrEqual(CLAIM_MAX);
    expect((f?.failureScenario ?? "").length).toBeLessThanOrEqual(2000);
  });

  it("throws rather than reporting nothing when OSV cannot be reached", async () => {
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(queryCommit(commit, dead)).rejects.toThrow(/DID NOT RUN/);
  });

  // Fingerprint 76bdeb0c: /v1/query paginates the same way /v1/querybatch
  // does (bfa2e44b's own fix already refuses it there) — a top-level
  // next_page_token means this commit's own vulnerability list was
  // truncated, not complete.
  it("refuses a truncated commit query rather than reporting it as complete", async () => {
    const truncated = (async () =>
      new Response(JSON.stringify({ vulns: [vuln], next_page_token: "abc" }), { status: 200 })) as unknown as typeof fetch;
    await expect(queryCommit(commit, truncated)).rejects.toThrow(/DID NOT RUN/);
  });
});

describe("vulnIdOf", () => {
  it("recognises the identifier schemes OSV federates, anchored to its own evidence shape", () => {
    expect(vulnIdOf("OSV GHSA-xxxx-yyyy-zzzz (CVE-2020-8203)")).toBe("GHSA-xxxx-yyyy-zzzz");
    expect(vulnIdOf("OSV CVE-2021-1234\nnpm package foo@1.0.0")).toBe("CVE-2021-1234");
    expect(vulnIdOf("no identifier here")).toBeUndefined();
  });

  // Fingerprint f6b7d999: OSV federates the OpenSSF malicious-packages database
  // under a MAL- prefix, distinct from CVE/GHSA/PYSEC/RUSTSEC/GO — the one
  // finding class a supply-chain review most exists to surface.
  it("recognises OSV's own malicious-package id scheme", () => {
    expect(vulnIdOf("OSV MAL-2024-1234\nnpm package evil-pkg@1.0.0")).toBe("MAL-2024-1234");
  });

  // `origin === "t0"` (buildVex, vex.ts) only tells a scanner finding from a model
  // tier's — semgrep shares that same "t0" origin with osv, and a registry rule
  // legitimately cites a CVE by name to explain what pattern it detects. That is
  // prose, not osv.ts's own structured evidence, and matching it anyway is the
  // same defect fingerprint 8a8ec642 named, one engine deeper.
  it("does not match a vuln id mentioned in unstructured prose", () => {
    expect(vulnIdOf("see CVE-2021-1234 for details")).toBeUndefined();
    expect(vulnIdOf("this pattern was exploited in CVE-2017-5638 (Apache Struts)")).toBeUndefined();
  });
});

describe("stateFor", () => {
  it("maps verdicts onto CycloneDX analysis states", () => {
    expect(stateFor("fixed")).toBe("resolved");
    expect(stateFor("justified-accepted")).toBe("not_affected");
    expect(stateFor("justified-rejected")).toBe("exploitable");
  });

  // The line that matters most in this file. Silence is not a clearance: a VEX
  // document that marks unexamined vulnerabilities as harmless is a signed claim
  // that nobody checked.
  it("never marks an unexamined vulnerability as not affected", () => {
    expect(stateFor(undefined)).toBe("in_triage");
  });

  // Fingerprint 494b2281: expireStaleVerdicts (reviewer/review.ts) writes this
  // exact verdict/tier pair when an ACCEPTED justification's code moved — a
  // claim that needs re-examining, not a reviewer's own rejection. Both are
  // VerdictKind "justified-rejected"; only `tier` tells them apart.
  it("treats an expired justification as needing triage, not as confirmed exploitable", () => {
    expect(stateFor("justified-rejected", "expiry")).toBe("in_triage");
    expect(stateFor("justified-rejected", "t2")).toBe("exploitable");
    expect(stateFor("justified-rejected")).toBe("exploitable");
  });
});

describe("justificationFor", () => {
  it("recognises the common shapes of a reachability argument", () => {
    // Not shipped at all vs shipped but never executed — VEX separates these, and
    // so does this: "never imported" is absence, "never called" is unreachability.
    expect(justificationFor("the vulnerable module is never imported")).toBe("code_not_present");
    expect(justificationFor("defaultsDeep is never called")).toBe("code_not_reachable");
    expect(justificationFor("only enabled behind a config flag we do not set")).toBe("requires_configuration");
    expect(justificationFor("bounded by the schema check at api/route.ts:31")).toBe("protected_by_mitigating_control");
    expect(justificationFor("the endpoint is not exposed outside the perimeter")).toBe("protected_by_perimeter");
  });

  // A bad guess costs nothing: the enum is a hint for tooling and the prose reason
  // is carried verbatim in `detail` regardless.
  it("falls back to not-reachable for a reason it cannot place", () => {
    expect(justificationFor("we discussed it and it is fine")).toBe("code_not_reachable");
  });
});

const emptyDoc = (): VexDocument => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: { timestamp: "2026-08-03T00:00:00.000Z", component: { name: "demo", version: "0.0.0" } },
  components: [],
  vulnerabilities: [],
});

/**
 * Fingerprint d7af16cf: zero vulnerability statements reads as a clean tree —
 * but it is the identical shape a tree the sbom/osv engines never queried
 * produces. `vexGap` (below) computes WHY, if there is one; `renderVex` just
 * says so plainly when there is.
 */
describe("renderVex", () => {
  it("reports a clean tree as clean when there is no gap", () => {
    expect(renderVex(emptyDoc())).toBe("No known vulnerabilities matched in this tree.");
  });

  it("does not claim a clean tree when there is a gap", () => {
    const summary = renderVex(emptyDoc(), "osv: nothing to query");
    expect(summary).toContain("osv: nothing to query");
    expect(summary).not.toBe("No known vulnerabilities matched in this tree.");
  });
});

/**
 * Fingerprint 9b09e7c5, a9c12b7e: the first cut of this fix (d7af16cf) keyed
 * the caveat entirely on `checksSkippedFor`, which unions every round of the
 * review's WHOLE LIFETIME — so a transient round-1 outage poisoned the
 * summary forever — and is silent (not "clean", silent) both before t0's
 * first round completes and for a review TYPE that never runs sbom/osv at
 * all (code-arch). Both silences read as clean to a caller checking only for
 * an unavailable line.
 */
describe("vexGap", () => {
  let store: Store;
  let reviewId: string;

  beforeEach(() => {
    store = new Store(":memory:");
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    reviewId = "r1";
    store.createReview({
      id: reviewId, repoId, principal: "p", branch: "b", intoRef: "main", ticket: "t",
      type: "security", state: "running", ladder: initialState(),
    });
  });

  it("says a non-security review does not check dependencies, regardless of t0 state", () => {
    expect(vexGap(store, reviewId, "code-arch")).toMatch(/not a security review/);
  });

  it("says no round has completed yet when t0 has never run", () => {
    expect(vexGap(store, reviewId, "security")).toMatch(/no round has completed/);
  });

  it("reports the current round's osv/sbom gap", () => {
    const id = store.openTierRun(reviewId, "t0", 1, "2026-08-03T00:00:00.000Z");
    store.closeTierRun(id, "findings", ["osv: nothing to query", "eslint: not configured"]);
    const gap = vexGap(store, reviewId, "security");
    expect(gap).toContain("osv: nothing to query");
    expect(gap).not.toContain("eslint");
  });

  it("reports no gap once t0's latest round ran clean", () => {
    const id = store.openTierRun(reviewId, "t0", 1, "2026-08-03T00:00:00.000Z");
    store.closeTierRun(id, "clean", []);
    expect(vexGap(store, reviewId, "security")).toBeUndefined();
  });

  // The regression this fix exists for: a round-1 outage must not keep
  // marking round 3 — which ran fine — as unproven forever.
  it("does not let an earlier round's outage poison a later clean round", () => {
    const first = store.openTierRun(reviewId, "t0", 1, "2026-08-03T00:00:00.000Z");
    store.closeTierRun(first, "failed", ["osv: OSV enumeration or query failed: ECONNREFUSED"]);
    const second = store.openTierRun(reviewId, "t0", 2, "2026-08-03T01:00:00.000Z");
    store.closeTierRun(second, "clean", []);
    expect(vexGap(store, reviewId, "security")).toBeUndefined();
  });

  // Fingerprints 287b1a76, 12255b33: openTierRun writes the row (unavailable
  // NULL) at round START, before anything has run. Reading that row read
  // exactly like a round that finished and found nothing unavailable.
  it("does not read an in-flight round as a clean one", () => {
    store.openTierRun(reviewId, "t0", 1, "2026-08-03T00:00:00.000Z"); // never closed
    expect(vexGap(store, reviewId, "security")).toMatch(/no round has completed/);
  });

  it("falls back to the last CLOSED round while a newer one is still in flight", () => {
    const first = store.openTierRun(reviewId, "t0", 1, "2026-08-03T00:00:00.000Z");
    store.closeTierRun(first, "findings", ["osv: nothing to query"]);
    store.openTierRun(reviewId, "t0", 2, "2026-08-03T01:00:00.000Z"); // never closed
    expect(vexGap(store, reviewId, "security")).toContain("osv: nothing to query");
  });

  // Fingerprint 4ca2c2a4: review.ts's own catch block around runT0 used to
  // close a thrown round as ("failed", []) — the whole phase never even
  // attempted osv/sbom, and an empty unavailable list read as "ran clean".
  it("treats a whole-phase t0 crash as a gap, not as clean", () => {
    const id = store.openTierRun(reviewId, "t0", 1, "2026-08-03T00:00:00.000Z");
    store.closeTierRun(id, "failed", ["t0: threw before completing — ECONNREFUSED"]);
    expect(vexGap(store, reviewId, "security")).toContain("t0: threw before completing");
  });

  // Fingerprint 118b5ec1, one layer past 287b1a76: excluding an in-flight
  // round is correct, but its OWN fallback — the last CLOSED round, while a
  // newer one is still running — can be a report about an EARLIER tree than
  // the one a submit already moved the review onto. "Ran clean" is only
  // true of the tree that round actually read.
  it("does not call an earlier tree's clean result current when a newer round is still running", () => {
    const first = store.openTierRun(reviewId, "t0", 1, "2026-08-03T00:00:00.000Z");
    store.closeTierRun(first, "clean", [], "tree-A");
    store.openTierRun(reviewId, "t0", 2, "2026-08-03T01:00:00.000Z"); // scanning tree-B, still open
    const gap = vexGap(store, reviewId, "security", "tree-B");
    expect(gap).toMatch(/earlier tree/);
  });

  it("still reports clean when the latest completed round matches the current tree", () => {
    const id = store.openTierRun(reviewId, "t0", 1, "2026-08-03T00:00:00.000Z");
    store.closeTierRun(id, "clean", [], "tree-A");
    expect(vexGap(store, reviewId, "security", "tree-A")).toBeUndefined();
  });
});

describe("buildVex", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id: "r1", repoId, principal: "p", branch: "b", intoRef: "main", ticket: "t",
      type: "security", state: "running", ladder: initialState(),
    });
    store.recordFinding("r1", {
      ...toFindings([{ component, vulns: [vuln] }])[0]!,
      fingerprint: "aaaa1111",
      // The literal value every T0 engine writes (review.ts) — never a per-engine
      // name, "osv" included. See RecordedFinding.origin's own doc comment.
      origin: "t0",
      round: 1,
      firstSeen: "2026-08-03T00:00:00.000Z",
    });
  });

  it("emits a triage statement for a finding nobody has ruled on", () => {
    const doc = buildVex(store, "r1", { name: "demo", version: "0.0.0" }, "2026-08-03T00:00:00.000Z");
    const v = doc.vulnerabilities[0] as { id: string; analysis: { state: string } };
    expect(v.id).toBe("GHSA-xxxx-yyyy-zzzz");
    expect(v.analysis.state).toBe("in_triage");
  });

  it("carries an accepted justification through as a not-affected statement", () => {
    store.recordVerdict("r1", {
      fingerprint: "aaaa1111",
      verdict: "justified-accepted",
      rationale: "defaultsDeep is never called; we only use lodash.get",
      scope: undefined,
      tier: "t2",
      round: 1,
    });
    const doc = buildVex(store, "r1", { name: "demo", version: "0.0.0" }, "2026-08-03T00:00:00.000Z");
    const v = doc.vulnerabilities[0] as { analysis: { state: string; justification: string; detail: string } };
    expect(v.analysis.state).toBe("not_affected");
    // VEX draws this line precisely: `code_not_present` means the vulnerable code
    // is not in the shipped artifact at all, while `code_not_reachable` means it is
    // there but never executed. "defaultsDeep is never called" is the latter.
    expect(v.analysis.justification).toBe("code_not_reachable");
    // The prose survives verbatim: the enum is for tools, the detail is the truth.
    expect(v.analysis.detail).toContain("defaultsDeep is never called");
  });

  it("ignores code-review findings, which are not VEX subjects", () => {
    store.recordFinding("r1", {
      fingerprint: "bbbb2222", file: "src/a.ts", severity: "low",
      claim: "naming is inconsistent", evidence: "no identifier here", failureScenario: "confusion",
      origin: "t1", round: 1, firstSeen: "2026-08-03T00:00:00.000Z",
    });
    const doc = buildVex(store, "r1", { name: "demo", version: "0.0.0" }, "2026-08-03T00:00:00.000Z");
    expect(doc.vulnerabilities).toHaveLength(1);
  });

  it("says plainly when statements are still untriaged", () => {
    const doc = buildVex(store, "r1", { name: "demo", version: "0.0.0" }, "2026-08-03T00:00:00.000Z");
    expect(renderVex(doc)).toContain("Do not read that as safe");
  });

  // Fingerprint 8a8ec642: a model tier's commentary can cite a CVE id in passing
  // without the finding being a scanner-verified vulnerability statement at all.
  // This evidence is shaped exactly like osv.ts's own output — `vulnIdOf` alone
  // cannot tell these apart, only `origin` can.
  it("ignores a model-tier finding even when its evidence is OSV-shaped", () => {
    store.recordFinding("r1", {
      fingerprint: "cccc3333",
      file: "src/a.ts",
      severity: "low",
      claim: "this looks related to a known CVE",
      evidence: "OSV CVE-2021-44228 (Log4Shell) was the closest precedent we found for this shape",
      failureScenario: "n/a",
      origin: "t2",
      round: 1,
      firstSeen: "2026-08-03T00:00:00.000Z",
    });
    const doc = buildVex(store, "r1", { name: "demo", version: "0.0.0" }, "2026-08-03T00:00:00.000Z");
    // Still just the one real, t0-origin statement from beforeEach.
    expect(doc.vulnerabilities).toHaveLength(1);
  });

  // Fingerprint f7cbff4c: CycloneDX's own schema requires affects[].ref to
  // resolve to a bom-ref declared in this SAME document's components[] — a
  // bare file path resolves to nothing a spec-conformant consumer can find.
  it("points affects[].ref at a real bom-ref this document actually declares", () => {
    const doc = buildVex(store, "r1", { name: "demo", version: "0.0.0" }, "2026-08-03T00:00:00.000Z");
    const ref = doc.vulnerabilities[0]?.affects[0]?.ref;
    expect(ref).toBeDefined();
    expect(doc.components.some((c) => c["bom-ref"] === ref)).toBe(true);
    expect(doc.components[0]?.name).toBe("lodash@4.17.20");
  });
});

describe("findingsNeedingTriage", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
    const repoId = store.upsertRepo("demo", "git@x:demo.git").id;
    store.createReview({
      id: "r1", repoId, principal: "p", branch: "b", intoRef: "main", ticket: "t",
      type: "security", state: "running", ladder: initialState(),
    });
  });

  it("finds an untriaged OSV finding", () => {
    store.recordFinding("r1", {
      ...toFindings([{ component, vulns: [vuln] }])[0]!,
      fingerprint: "aaaa1111",
      origin: "t0",
      round: 1,
      firstSeen: "2026-08-03T00:00:00.000Z",
    });
    expect(findingsNeedingTriage(store, "r1")).toHaveLength(1);
  });

  // The same distinction buildVex draws, above: model-tier commentary that cites
  // a CVE is not a scanner finding.
  it("excludes a model-tier finding even when its evidence names a CVE", () => {
    store.recordFinding("r1", {
      fingerprint: "bbbb2222",
      file: "src/a.ts",
      severity: "low",
      claim: "this pattern resembles the Log4Shell class of bug",
      evidence: "OSV CVE-2021-44228 was the closest public precedent we found for this shape",
      failureScenario: "n/a",
      origin: "t2",
      round: 1,
      firstSeen: "2026-08-03T00:00:00.000Z",
    });
    expect(findingsNeedingTriage(store, "r1")).toHaveLength(0);
  });
});
