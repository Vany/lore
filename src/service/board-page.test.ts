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
function loadPage(): {
  render: (b: unknown) => void;
  prLink: (r: unknown) => string;
  refactorRow: (r: unknown) => string;
  combinedRows: (reviews: unknown[], refactorRuns: unknown[]) => { kind: string }[];
  byId: Map<string, ReturnType<typeof element>>;
} {
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
  return {
    render: sandbox["render"] as (b: unknown) => void,
    prLink: sandbox["prLink"] as (r: unknown) => string,
    refactorRow: sandbox["refactorRow"] as (r: unknown) => string,
    combinedRows: sandbox["combinedRows"] as (reviews: unknown[], refactorRuns: unknown[]) => { kind: string }[],
    byId,
  };
}

const snapshot = (over: Record<string, unknown> = {}) => ({
  at: new Date().toISOString(),
  build: { commit: "abc1234", builtAt: new Date().toISOString() },
  draining: false,
  providers: [{ route: "zai-coding-plan/glm-5.2" }],
  load: [1.25, 2.5, 3.75],
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
              cwe: "CWE-89",
              // The "<script>&boom" is deliberate: evidence routinely quotes source code,
              // so a real finding's text WILL contain "<", ">", "&" and quotes.
              claim: "reads x < y without a bound",
              evidence: 'const s = "<script>&boom</script>";',
              failureScenario: "given x=1 & y=0, it throws",
              preexisting: false,
              settled: undefined,
              settledRationale: undefined,
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

/** A refactor run (D-136), for the board-visibility tests (D-139). */
const refactorRunFixture = (over: Record<string, unknown> = {}) => ({
  id: "refactor_abc123",
  folder: "src/reviewer",
  commitSha: "0fc40047ed8931bb095eb66575937bf8cf62fa0a",
  principal: "vany",
  state: "running",
  createdAt: new Date(Date.now() - 300_000).toISOString(),
  endedAt: undefined,
  movedAt: new Date(Date.now() - 30_000).toISOString(),
  combinerNote: undefined,
  lastError: undefined,
  queuedNote: undefined,
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
    render(snapshot({ spendTodayUsd: 4 }));
    expect(() => render(snapshot({ spendTodayUsd: 9 }))).not.toThrow();
  });

  // D-135: claim/evidence/failureScenario reach the page again, reversing D-96's
  // 2026-08-28 revision (fingerprint 240a9efa's original fix) — Vany's explicit call
  // that a pre-production finding is not secret data. Escaped exactly like every other
  // untrusted string on this page: the fixture's evidence deliberately contains
  // "<script>&boom</script>", because real T0 evidence routinely quotes source code.
  it("shows the whole finding, claim and all", () => {
    const { render, byId } = loadPage();
    render(snapshot());

    const html = String(byId.get("board")?.innerHTML ?? "");
    expect(html, "the finding row must exist to make the checks below meaningful").toContain("abcd1234");
    expect(html, "fingerprint/symbol/cwe still lead the summary").toContain("abcd1234 · f · CWE-89");
    expect(html, "the claim is rendered").toContain("reads x &lt; y without a bound");
    expect(html, "evidence is escaped, not stripped").toContain(
      "const s = &quot;&lt;script&gt;&amp;boom&lt;/script&gt;&quot;;",
    );
    expect(html, "raw markup must never reach the DOM unescaped").not.toContain("<script>&boom</script>");
    expect(html, "the failure scenario is rendered").toContain("given x=1 &amp; y=0, it throws");
    expect(html, "the old placeholder sentence is gone").not.toContain(
      "what this claims is not shown on this unauthenticated board",
    );
  });

  // D-135: the reasoning behind a settled verdict reaches the page again too, same
  // reversal, same reasoning as the fix above (fingerprint 969fa523's original fix).
  it("shows that a finding was settled, and why", () => {
    const { render, byId } = loadPage();
    const base = snapshot();
    render({
      ...base,
      reviews: [
        {
          ...(base.reviews[0] as Record<string, unknown>),
          tiers: [
            {
              tier: "t1",
              round: 1,
              outcome: "findings",
              startedAt: new Date(Date.now() - 500_000).toISOString(),
              finishedAt: new Date(Date.now() - 400_000).toISOString(),
              findings: [
                {
                  fingerprint: "beef5678",
                  severity: "medium",
                  file: "b.ts",
                  line: 9,
                  symbol: "g",
                  cwe: undefined,
                  claim: "c", evidence: "e", failureScenario: "s",
                  preexisting: false,
                  settled: "justified-accepted",
                  settledRationale: "bounded upstream — the caller already validates this before it reaches here",
                },
              ],
            },
          ],
        },
      ],
    });

    const html = String(byId.get("board")?.innerHTML ?? "");
    expect(html, "the row must exist to make the checks below meaningful").toContain("beef5678");
    expect(html, "the verdict KIND still reaches an unauthenticated reader").toContain("justified-accepted");
    expect(html, "the rationale behind it reaches the reader too").toContain(
      "bounded upstream — the caller already validates this before it reaches here",
    );
  });

  // Fingerprint d767498a, found by lore's own review of the OOM-kill fix: this
  // page keeps its own copy of the tier_run outcome vocabulary, and the new
  // 'interrupted' outcome (store.ts) reached ops/status.ts but not here — an
  // interrupted t0 round with zero findings rendered the red cross mark AND
  // "raised nothing", the exact INV-1 sentence a comment five lines above it
  // says must never appear for a run that did not happen.
  it("renders an interrupted t0 round as neither failed nor a clean sweep", () => {
    const { render, byId } = loadPage();
    const base = snapshot();
    render({
      ...base,
      reviews: [
        {
          ...(base.reviews[0] as Record<string, unknown>),
          tiers: [
            {
              tier: "t0",
              round: 2,
              outcome: "interrupted",
              startedAt: new Date(Date.now() - 90_000).toISOString(),
              finishedAt: new Date(Date.now() - 60_000).toISOString(),
              findings: [],
            },
          ],
        },
      ],
    });

    const html = String(byId.get("board")?.innerHTML ?? "");
    expect(html, "the row must exist to make either claim below meaningful").toContain("interrupted");
    expect(html, "an interrupted run is not the same red mark as one that never ran").not.toContain("s-failed");
    expect(html, "the exact overclaim this fix removes").not.toContain("raised nothing");
  });

  // Fingerprint 3e1abbb4: the d767498a fix above special-cased 'interrupted'
  // and missed that failed/unpayable/stopped are the SAME overclaim from a
  // different trigger — each means the sweep did not complete, exactly as
  // ops/status.ts's own didNotRun already treats all three alike. UNLIKE
  // interrupted, these three keep the red s-failed mark (ops/status.ts's own
  // precedent again) — only the "raised nothing" TEXT is the overclaim.
  it.each(["failed", "unpayable", "stopped"] as const)(
    "renders a %s t0 round with zero findings as unfinished, not as a clean sweep",
    (outcome) => {
      const { render, byId } = loadPage();
      const base = snapshot();
      render({
        ...base,
        reviews: [
          {
            ...(base.reviews[0] as Record<string, unknown>),
            tiers: [
              {
                tier: "t0",
                round: 2,
                outcome,
                startedAt: new Date(Date.now() - 90_000).toISOString(),
                finishedAt: new Date(Date.now() - 60_000).toISOString(),
                findings: [],
              },
            ],
          },
        ],
      });

      const html = String(byId.get("board")?.innerHTML ?? "");
      expect(html, "the row must exist to make either claim below meaningful").toContain(outcome);
      expect(html, "the exact overclaim this fix removes").not.toContain("raised nothing");
    },
  );

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
    render(snapshot({ spendTodayUsd: 12.5 }));
    expect(byId.get("spend")?.["textContent"]).toBe("$12.50");
    expect(byId.get("open")?.["textContent"]).toBe("3/128");
    expect(byId.get("build")?.["textContent"]).toBe("abc1234");
    // The 1-minute figure beside the hash; the triple lives in the hover title.
    expect(byId.get("la")?.["textContent"]).toBe("1.3");
    expect(String(byId.get("la")?.["title"])).toContain("1.25 2.50 3.75");
  });

  it("survives a snapshot with no load reading", () => {
    const { render, byId } = loadPage();
    render(snapshot({ load: undefined }));
    expect(byId.get("la")?.["textContent"]).toBe("\u2014");
  });

  /**
   * THE STATUS LINE ANSWERS "WHICH SUBSCRIPTION IS OUT, AND WHEN IS IT BACK" (D-93).
   *
   * Vany removed `queued` and `in flight` — near-constant zeros since D-98/D-101 — and
   * asked for per-provider quota instead. A PERCENTAGE is not knowable (no provider
   * publishes one, D-84), so the chips show hours-to-reset, tilde-marked when the time
   * is lore's own doubling guess rather than the provider's word.
   */
  it("shows a chip per route: ok when believed payable, hours when parked", () => {
    const { render, byId } = loadPage();
    const in5h = new Date(Date.now() + 5 * 3600000).toISOString();
    render(
      snapshot({
        providers: [
          { route: "zai-coding-plan/glm-5.2" },
          { route: "kimi-for-coding/k3", until: in5h, stated: false },
        ],
      }),
    );
    const html = String(byId.get("providers")?.["innerHTML"] ?? "");
    expect(html).toContain("zai-coding-plan");
    expect(html).toContain(">ok<");
    expect(html, "a guessed reset carries the tilde").toContain(">~5h<");
    expect(html).toContain("kimi-for-coding");
  });

  it("tells two plans of one provider apart, and the header survives no providers at all", () => {
    const { render, byId } = loadPage();
    render(
      snapshot({
        providers: [
          { route: "zai-coding-plan/glm-5.2" },
          { route: "zai-coding-plan2/glm-5.2" },
          { route: "openrouter/z-ai/glm-5.2" },
          { route: "openrouter/moonshotai/kimi-k3" },
        ],
      }),
    );
    const html = String(byId.get("providers")?.["innerHTML"] ?? "");
    // openrouter carries two twins here, so each chip names its model too.
    expect(html).toContain("openrouter\u00b7glm-5.2".replace("\\u00b7", "\u00b7"));
    expect(html).toContain("openrouter\u00b7kimi-k3".replace("\\u00b7", "\u00b7"));

    expect(() => render(snapshot({ providers: undefined }))).not.toThrow();
  });
});

/**
 * THE PR IS A VISIBLE NUMBER IN ITS OWN COLUMN, between state and branch — Vany's
 * correction after one deploy of it riding inside the branch cell: a number trailing a
 * variable-length name is in a different place on every row; a column is the thing an
 * eye can sweep.
 */
describe("the PR column on a review row", () => {
  it("shows #number linking to the PR", () => {
    const { prLink } = loadPage();
    const html = prLink({ branch: "feat/x", pullRequest: "https://github.com/o/r/pull/395" });
    expect(html).toContain(">#395</a>");
    expect(html).toContain('href="https://github.com/o/r/pull/395"');
    expect(html, "the branch name does not live in this cell").not.toContain("feat/x");
  });

  // Empty, not a dash: a dash implies a value this row is missing, and most rows
  // legitimately have no PR at all.
  it("is empty when there is no PR, never a dead link", () => {
    const { prLink } = loadPage();
    expect(prLink({ branch: "feat/x" })).toBe("");
  });

  // The second scheme check is this page's whole reason: a stored javascript: URL would
  // be somebody else's script on the page an operator opens when something is wrong.
  it("refuses a non-http scheme outright", () => {
    const { prLink } = loadPage();
    expect(prLink({ branch: "b", pullRequest: "javascript:alert(1)" })).toBe("");
  });

  it("marks a URL with no trailing number as a PR without inventing one", () => {
    const { prLink } = loadPage();
    const html = prLink({ branch: "b", pullRequest: "https://forge.example/x/changes/abc" });
    expect(html).toContain("<a");
    expect(html).not.toContain("#");
  });
});

/**
 * A REFACTOR RUN ON THE SAME BOARD, LABELLED SO IT CANNOT BE MISTAKEN FOR A REVIEW
 * (D-136's own feature, board visibility D-139) — Vany: *"let's show running refactor
 * session as REFACTOR in the web."*
 */
describe("a refactor run on the board", () => {
  it("renders without throwing, alongside reviews", () => {
    const { render } = loadPage();
    expect(() =>
      render(snapshot({ refactorRuns: [refactorRunFixture()], refactorRunsNotShown: 0 })),
    ).not.toThrow();
  });

  it("carries the REFACTOR tag, the folder, a short commit and the state", () => {
    const { refactorRow } = loadPage();
    const html = refactorRow(refactorRunFixture({ state: "running", folder: "src/reviewer" }));
    expect(html).toContain("REFACTOR");
    expect(html).toContain("src/reviewer");
    // Full sha in the title (hover), short sha in the visible text.
    expect(html).toContain("0fc40047ed8931bb095eb66575937bf8cf62fa0a");
    expect(html).toContain("@0fc40047");
    expect(html).toContain(">RUNNING<");
  });

  it("renders every state a refactor run can be in", () => {
    const { refactorRow } = loadPage();
    for (const state of ["queued", "running", "done", "failed"]) {
      expect(() => refactorRow(refactorRunFixture({ state }))).not.toThrow();
      expect(refactorRow(refactorRunFixture({ state }))).toContain(">" + state.toUpperCase() + "<");
    }
  });

  it("freezes the used clock once terminal, exactly like a review row", () => {
    const { refactorRow } = loadPage();
    const started = new Date(Date.now() - 600_000).toISOString();
    const ended = new Date(Date.now() - 60_000).toISOString();
    const html = refactorRow(refactorRunFixture({ state: "done", createdAt: started, endedAt: ended }));
    // A fixed duration, not a data-used timestamp the browser would keep counting up.
    expect(html).not.toContain("data-used=");
    expect(html).toContain("9m");
  });

  /**
   * THE STALL CLOCK MUST WORK FOR A REFACTOR RUN TOO — it is the whole reason this
   * board exists (ops/board.ts's own opening comment: "why has that been going forty
   * minutes"), and a refactor run can wedge exactly as a review can.
   */
  it("carries data-stall from movedAt, so the page's own clock can tick it", () => {
    const { refactorRow } = loadPage();
    const movedAt = new Date(Date.now() - 120_000).toISOString();
    const html = refactorRow(refactorRunFixture({ state: "running", movedAt }));
    expect(html).toContain('data-stall="' + movedAt + '"');
    expect(html).toContain('data-terminal="false"');
  });

  /**
   * A RUNNING REFACTOR SITS AMONG RUNNING REVIEWS, NOT BELOW THEM — the merge is by
   * recency and unfinished-first, the same rule ops/board.ts's own SQL already applies
   * within reviews alone (see "puts unfinished work above finished work" above).
   */
  it("interleaves with reviews by recency, unfinished work first", () => {
    const { combinedRows } = loadPage();
    // The FINISHED review is the more recently updated of the two — isolating the
    // terminal-first rule from plain recency, the same way board.test.ts's own "puts
    // unfinished work above finished work" does for reviews alone.
    const freshButDoneReview = { state: "passed", movedAt: new Date(Date.now() - 1_000).toISOString() };
    const olderButRunningRefactor = { state: "running", movedAt: new Date(Date.now() - 3_600_000).toISOString() };
    const rows = combinedRows([freshButDoneReview], [olderButRunningRefactor]);
    // toEqual, not toStrictEqual: `combinedRows` runs inside the vm sandbox (a separate
    // realm), so the array and its elements are that realm's own Array/Object — content-
    // equal to a plain literal built out here, but never prototype-identical to one.
    expect(rows.map((r) => r.kind)).toEqual(["refactor", "review"]);
  });

  it("says out loud what the row cap left out, same as it does for reviews", () => {
    const { render } = loadPage();
    expect(() =>
      render(snapshot({ refactorRuns: [refactorRunFixture()], refactorRunsNotShown: 4 })),
    ).not.toThrow();
  });

  it("shows a combiner note and a last error when the run has them", () => {
    const { render } = loadPage();
    expect(() =>
      render(
        snapshot({
          refactorRuns: [
            refactorRunFixture({
              state: "done",
              endedAt: new Date().toISOString(),
              combinerNote: "t1 was unconfigured; showing the raw union of both sets",
            }),
          ],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      render(
        snapshot({
          refactorRuns: [refactorRunFixture({ state: "failed", lastError: "worktree checkout failed" })],
        }),
      ),
    ).not.toThrow();
  });

  // lore-ok[0e86f2d0]: found by lore's own review — every test above this one either
  // asserts `.not.toThrow()` or calls `refactorRow`/`combinedRows` directly, so none of
  // them prove the REFACTOR tag, the folder, the state or a note ever reach the actual
  // `#board` element's innerHTML the way `render()` assembles it (join, notShown banner,
  // and all) — the exact gap "shows the whole finding, claim and all" (above, for
  // reviews) closes for findings. This closes it for refactor runs.
  it("reaches the real DOM: REFACTOR tag, folder, state, queued note, and the row-cap banner", () => {
    const { render, byId } = loadPage();
    render(
      snapshot({
        reviews: [],
        refactorRuns: [
          refactorRunFixture({
            state: "queued",
            folder: "src/reviewer",
            queuedNote: "queued — no worker has claimed it yet, so NOTHING has run.",
          }),
        ],
        refactorRunsNotShown: 4,
      }),
    );
    const html = String(byId.get("board")?.innerHTML ?? "");
    expect(html, "the REFACTOR tag must reach the DOM, not just refactorRow's own return value").toContain("REFACTOR");
    expect(html, "the folder must reach the DOM").toContain("src/reviewer");
    expect(html, "the state must reach the DOM").toContain(">QUEUED<");
    expect(html, "the server-computed queuedNote must reach the DOM (fingerprint 2e972f8c)").toContain(
      "queued — no worker has claimed it yet, so NOTHING has run.",
    );
    expect(html, "the row-cap banner must render for refactor runs too, not just log .not.toThrow()").toContain(
      "4 more refactor run(s) exist and are NOT listed here",
    );
  });

  // A board built before D-139 sends no refactorRuns field at all — must degrade to
  // "none", never throw on the missing array.
  it("copes with a snapshot that predates refactorRuns entirely", () => {
    const { render } = loadPage();
    const s = snapshot();
    delete (s as Record<string, unknown>)["refactorRuns"];
    expect(() => render(s)).not.toThrow();
  });
});

/**
 * THE HEADER ROW MUST NAME AS MANY COLUMNS AS THE GRID HAS.
 *
 * The PR column was added to `.grid`'s CSS template and to every data row in `row()`,
 * but not to the static header markup — six labels over a seven-track grid, so every
 * label after `state` sat one column left of the data it actually named. Both counts
 * live in the STATIC template string, so a string-level check is enough to pin them
 * without executing the page's own JS — and catches the next column added to one but
 * not the other.
 */
describe("the board header matches the grid it labels", () => {
  it("names one <span> per grid-template-columns track", () => {
    const cols = /grid-template-columns:\s*([^;]+);/.exec(BOARD_PAGE);
    expect(cols, "the grid's own column list must be findable").not.toBeNull();
    const trackCount = (cols?.[1] ?? "").trim().split(/\s+/).length;

    const head = /<div class="grid head" id="head" hidden>([\s\S]*?)<\/div>/.exec(BOARD_PAGE);
    expect(head, "the header row must be findable").not.toBeNull();
    const headerCells = (head?.[1] ?? "").match(/<span/g)?.length ?? 0;

    expect(headerCells).toBe(trackCount);
  });
});
