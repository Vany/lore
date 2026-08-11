/**
 * THE PAGE'S OWN JAVASCRIPT, ACTUALLY EXECUTED.
 *
 * Nothing did. `board.test.ts` exercises the data, `board-stream.test.ts` the SSE
 * mechanics, and `http.test.ts` that the HTML is served — and all three were green while
 * `render()` threw on every call. A `const open` added for the open-review counter shadowed
 * the module-level `Set` of expanded rows, so `open.has` was called on an HTMLSpanElement.
 *
 * What that produced is the reason this file exists rather than a note in TODO. The rows
 * were already painted by the `innerHTML` assignment before the throw, and the clock timer
 * lives outside `render`, so **the board looked alive**: data on screen, seconds counting
 * up, SSE connected — and frozen on the first snapshot for as long as the tab stayed open.
 * A healthy-looking view of stale data is the exact failure this service exists to refuse,
 * and it shipped in the page built to refuse it.
 *
 * No jsdom, no new dependency: the script needs about thirty DOM methods and they are
 * stubbed below. That is enough to catch what actually goes wrong here — a name that does
 * not resolve, a method called on the wrong kind of thing, a field the payload stopped
 * carrying — which is every browser-side defect this page has had.
 */

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { BOARD_PAGE } from "./board-page.ts";

/** One element, with just enough of the DOM to run the page. */
function element(tag = "div") {
  const el: Record<string, unknown> = {
    tagName: tag,
    dataset: {},
    children: [] as unknown[],
    className: "",
    textContent: "",
    hidden: false,
    open: false,
    disabled: false,
    style: {},
    _html: "",
    get innerHTML() {
      return el["_html"];
    },
    // The real one parses; we only need to know it was set, and to keep serving the
    // elements the test registered. Nothing here asserts on generated markup — that is
    // what a snapshot test would do, and it would break on every wording change.
    set innerHTML(v: unknown) {
      el["_html"] = v;
    },
    appendChild: (c: unknown) => (el["children"] as unknown[]).push(c),
    addEventListener: () => undefined,
    // NOT AN EMPTY ARRAY, and the first version of this file returned one — which made
    // every test here pass with the shadowing bug deliberately reintroduced. `render`
    // reaches `open.has(...)` only inside `for (const d of main.querySelectorAll(...))`,
    // so a stub that finds nothing never executes the line that throws. A test that
    // cannot fail is worse than no test: it reports that the browser code was exercised.
    //
    // Two of each, because one would not catch an accumulate-per-element mistake and the
    // page never has exactly one of anything interesting.
    querySelectorAll: (sel: string) => [element(sel), element(sel)],
    querySelector: () => element(),
    closest: () => element(),
  };
  return el;
}

/** Run the page's script against a stub DOM and hand back what it defined. */
function loadPage(): { render: (b: unknown) => void; byId: Map<string, ReturnType<typeof element>> } {
  const script = BOARD_PAGE.slice(BOARD_PAGE.indexOf("<script>") + 8, BOARD_PAGE.lastIndexOf("</script>"));
  expect(script.length, "the page has no script to run").toBeGreaterThan(500);

  const byId = new Map<string, ReturnType<typeof element>>();
  const get = (id: string) => {
    const found = byId.get(id) ?? element();
    byId.set(id, found);
    return found;
  };
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: get,
      querySelectorAll: () => [] as unknown[],
      createElement: (t: string) => element(t),
    },
    // The page opens one on load. A constructor that records nothing is enough: the
    // stream is `board-stream.test.ts`'s subject, not this file's.
    EventSource: class {
      onopen?: () => void;
      onmessage?: (e: unknown) => void;
      onerror?: () => void;
    },
    setInterval: () => 0,
    clearInterval: () => undefined,
    confirm: () => false,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    console,
  };
  runInNewContext(script, sandbox);
  return { render: sandbox["render"] as (b: unknown) => void, byId };
}

const snapshot = (over: Record<string, unknown> = {}) => ({
  at: new Date().toISOString(),
  build: { commit: "abc1234", builtAt: new Date().toISOString() },
  draining: false,
  queued: 0,
  inFlight: 0,
  modelCalls: { inFlight: 2 },
  openReviews: { open: 3, limit: 128 },
  spendTodayUsd: 1.5,
  tiersDown: [],
  reviewsNotShown: 0,
  reviews: [
    {
      id: "rev1",
      branch: "feat/x",
      pullRequest: "https://example.invalid/pr/1",
      into: "main",
      type: "code-arch",
      state: "running",
      round: 2,
      createdAt: new Date(Date.now() - 600_000).toISOString(),
      endedAt: undefined,
      movedAt: new Date(Date.now() - 60_000).toISOString(),
      step: "t2",
      stepNote: undefined,
      tiers: [
        {
          tier: "t1",
          round: 1,
          outcome: "findings",
          startedAt: new Date(Date.now() - 500_000).toISOString(),
          finishedAt: new Date(Date.now() - 400_000).toISOString(),
          findings: [
            {
              fingerprint: "abcd1234",
              severity: "high",
              file: "a.ts",
              line: 4,
              symbol: "f",
              claim: "c",
              evidence: "e",
              failureScenario: "s",
              cwe: "CWE-89",
              preexisting: false,
              settled: undefined,
              settledBecause: undefined,
            },
          ],
        },
      ],
      findings: { high: 1, medium: 0, low: 0, open: 1 },
      checksSkipped: ["eslint: not configured"],
      orphanFindings: [],
      findingsNotShown: 0,
      openQuestions: [],
    },
  ],
  ...over,
});

describe("the board's own script runs", () => {
  it("renders a snapshot without throwing", () => {
    const { render } = loadPage();
    expect(() => render(snapshot())).not.toThrow();
  });

  /**
   * THE REGRESSION. `open` is the module-level Set of expanded rows; a local of the same
   * name turned `open.has(...)` into a call on an HTMLSpanElement and killed every render
   * after the first paint. It throws on the FIRST call with reviews, so one render is
   * enough to catch it — which is exactly how cheap this test needed to be.
   */
  it("renders repeatedly, as a live board does", () => {
    const { render } = loadPage();
    render(snapshot());
    render(snapshot({ queued: 4 }));
    expect(() => render(snapshot({ queued: 9 }))).not.toThrow();
  });

  it("renders the states that have their own shapes", () => {
    const { render } = loadPage();
    const base = snapshot();
    const one = (over: Record<string, unknown>) => ({
      ...base,
      reviews: [{ ...(base.reviews[0] as Record<string, unknown>), ...over }],
    });

    // A review parked on a person, with the question and its buttons.
    expect(() =>
      render(
        one({
          state: "needs_human",
          step: undefined,
          openQuestions: [
            {
              repoId: "repo1",
              left: { id: "l1", statement: "A", source: "docs" },
              right: { id: "r1", statement: "not A", source: "koray" },
            },
          ],
        }),
      ),
    ).not.toThrow();

    // Parked with nothing left to decide — the state the page turns into a sentence.
    expect(() => render(one({ state: "needs_human", step: undefined, openQuestions: [] }))).not.toThrow();
    // Finished: the total is frozen from endedAt rather than counted to now.
    expect(() =>
      render(one({ state: "passed", step: undefined, endedAt: new Date().toISOString() })),
    ).not.toThrow();
    // The stall this page exists for.
    expect(() => render(one({ state: "running", step: undefined, stepNote: "NO TIER IS WORKING — …" }))).not.toThrow();
    // A branch with no pull request must render as text, not as a dead link.
    expect(() => render(one({ pullRequest: undefined }))).not.toThrow();
  });

  it("renders an empty board and the banners", () => {
    const { render } = loadPage();
    expect(() =>
      render(
        snapshot({
          reviews: [],
          draining: true,
          reviewsNotShown: 7,
          tiersDown: [{ tier: "t1", until: new Date().toISOString(), why: "out of quota", stated: true }],
        }),
      ),
    ).not.toThrow();
  });

  // Absent is not zero: a build with no reviewer sends no `modelCalls` at all, and the
  // header has to cope rather than print `undefined`.
  it("copes with a snapshot that has no model-call reading", () => {
    const { render, byId } = loadPage();
    render(snapshot({ modelCalls: undefined }));
    expect(byId.get("calls")?.["textContent"]).toBe("—");
  });

  it("puts the numbers it was given into the header", () => {
    const { render, byId } = loadPage();
    render(snapshot({ queued: 6, inFlight: 2, spendTodayUsd: 12.5 }));
    expect(byId.get("queued")?.["textContent"]).toBe(6);
    expect(byId.get("spend")?.["textContent"]).toBe("$12.50");
    expect(byId.get("open")?.["textContent"]).toBe("3/128");
    expect(byId.get("build")?.["textContent"]).toBe("abc1234");
  });
});
