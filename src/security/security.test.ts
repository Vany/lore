import { beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../core/ladder.ts";
import { Store } from "../store/store.ts";
import { queryComponents, severityOf, fixedVersion, toFindings, type OsvVuln } from "./osv.ts";
import type { Component } from "./sbom.ts";
import { buildVex, justificationFor, stateFor, vulnIdOf, renderVex } from "./vex.ts";

const component: Component = { name: "lodash", version: "4.17.20", ecosystem: "npm", transitive: true };

const vuln: OsvVuln = {
  id: "GHSA-xxxx-yyyy-zzzz",
  summary: "prototype pollution in defaultsDeep",
  aliases: ["CVE-2020-8203"],
  database_specific: { severity: "HIGH", cwe_ids: ["CWE-1321"] },
  affected: [{ ranges: [{ events: [{ fixed: "4.17.21" }] }] }],
};

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
    expect(fixedVersion(vuln)).toBe("4.17.21");
  });

  it("returns nothing when no fix exists, rather than inventing one", () => {
    expect(fixedVersion({ id: "a", affected: [{ ranges: [{ events: [] }] }] })).toBeUndefined();
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
    expect((f?.claim ?? "").length).toBeLessThanOrEqual(300);
    expect((f?.failureScenario ?? "").length).toBeLessThanOrEqual(2000);
  });
});

describe("queryComponents", () => {
  it("returns only the components that matched", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ results: [{ vulns: [vuln] }, {}] }), { status: 200 })) as unknown as typeof fetch;
    const out = await queryComponents([component, { ...component, name: "safe-pkg" }], fake);
    expect(out).toHaveLength(1);
    expect(out[0]?.component.name).toBe("lodash");
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
});

describe("vulnIdOf", () => {
  it("recognises the identifier schemes OSV federates", () => {
    expect(vulnIdOf("OSV GHSA-xxxx-yyyy-zzzz (CVE-2020-8203)")).toBe("GHSA-xxxx-yyyy-zzzz");
    expect(vulnIdOf("see CVE-2021-1234 for details")).toBe("CVE-2021-1234");
    expect(vulnIdOf("no identifier here")).toBeUndefined();
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
      origin: "osv",
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
});
