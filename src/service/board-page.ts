/**
 * The operator board, as one self-contained page.
 *
 * No build step, no framework and no CDN: this is served by the same process it reports
 * on, so a dependency that fails to load turns the one view of a wedged service into a
 * blank page. Everything it needs is in this string.
 *
 * **The clocks tick in the browser, not on the wire.** The server sends absolute ISO
 * timestamps and pushes only when something actually CHANGES; the page recomputes every
 * elapsed time once a second from those timestamps. So a review sitting on t2 for twenty
 * minutes counts up smoothly while generating no traffic at all, and a lost connection is
 * visible as clocks that keep running against a stale banner rather than as a page that
 * silently freezes.
 *
 * SPEC: spec/operations.md §2.4
 */

export const BOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lore — board</title>
<style>
  :root {
    --bg: #0e1116; --fg: #d5dae1; --dim: #6b7480; --line: #232a33;
    --blue: #4c8dd8; --green: #3fa46a; --yellow: #d3a03a; --red: #d4574f; --mag: #a06ad3;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  header {
    position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line);
    padding: 10px 14px; display: flex; gap: 18px; align-items: baseline; flex-wrap: wrap;
  }
  h1 { font-size: 13px; margin: 0; font-weight: 700; letter-spacing: .5px; }
  .dim { color: var(--dim); }
  .k { color: var(--dim); margin-right: 4px; }
  main { padding: 8px 14px 40px; }

  /* A banner is only ever for a fact that changes how you read everything below it. */
  .banner { padding: 8px 14px; border-bottom: 1px solid var(--line); }
  .banner.drain { background: #3a2a12; color: #f0c674; }
  .banner.down  { background: #3a1a18; color: #f2a6a1; }
  .banner.gone  { background: #2a1a2f; color: #d9b3ee; }

  /* One template, two users: the label row and every summary must not drift apart. */
  .grid {
    display: grid; grid-template-columns: 15px 96px 1fr 150px 90px 90px;
    gap: 12px; align-items: baseline;
  }
  .head { padding: 6px 4px 4px; color: var(--dim); font-size: 11px; letter-spacing: .5px; }
  .head .r { text-align: right; }
  .rev { border-bottom: 1px solid var(--line); }
  summary { list-style: none; cursor: pointer; padding: 7px 4px; }
  .clock, .step-cell { text-align: right; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: #151b23; }
  .caret { color: var(--dim); }
  details[open] .caret { transform: rotate(90deg); display: inline-block; }
  .state { font-weight: 700; font-size: 11px; letter-spacing: .4px; }
  .branch { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Underlined only on hover: every branch that HAS a pull request would otherwise be a
     wall of underlines, and the ones without would read as broken rather than as absent. */
  .branch a { color: inherit; text-decoration: none; }
  .branch a:hover { text-decoration: underline; color: var(--blue); }
  .step { color: var(--blue); }
  /* The stall this board exists to catch, said in the COLLAPSED row. It used to be
     visible only after a click, which is one click more than an alarm may cost. */
  .nostep { color: var(--yellow); font-weight: 700; }
  .clock { font-variant-numeric: tabular-nums; }

  /* Time stalled is the number this page exists for; it earns colour, the others do not. */
  .stall-ok   { color: var(--dim); }
  .stall-warn { color: var(--yellow); }
  .stall-bad  { color: var(--red); font-weight: 700; }

  .body { padding: 4px 4px 14px 27px; }
  .run { margin: 6px 0; }
  .run-head { display: flex; gap: 14px; align-items: baseline; }
  .run-head > span { white-space: nowrap; }

  /* One finding, collapsed to a line. Indented under the attempt that raised it, so
     "which tier said this" needs no label — the nesting is the answer. */
  .fs { margin: 2px 0 0 18px; }
  .f { border-left: 2px solid var(--line); }
  .f > summary {
    list-style: none; cursor: pointer; padding: 2px 0 2px 8px;
    display: flex; gap: 10px; align-items: baseline;
  }
  .f > summary::-webkit-details-marker { display: none; }
  .f > summary:hover { background: #151b23; }
  .f[open] { border-left-color: var(--dim); }
  .f .where { color: var(--fg); white-space: nowrap; }
  .f .claim { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); }
  .f[open] .claim { white-space: normal; color: var(--fg); }
  .fbody { padding: 4px 0 8px 26px; max-width: 110ch; }
  .fbody .label { color: var(--dim); }
  .fbody p { margin: 3px 0; white-space: pre-wrap; }
  .settled { color: var(--green); }
  .pre { color: var(--mag); }
  .sev-high { color: var(--red); }
  .sev-medium { color: var(--yellow); }
  .sev-low { color: var(--dim); }
  .skip { color: var(--yellow); }
  .note { color: var(--yellow); }

  /* needs_human is the only state a person is the mechanism for, so it is the only thing
     in a detail pane that gets a box of its own. */
  .human {
    border: 1px solid var(--mag); border-left-width: 3px; border-radius: 2px;
    padding: 8px 10px; margin: 6px 0 10px; max-width: 110ch; color: var(--fg);
  }
  .human b { color: var(--mag); }
  .q { margin: 8px 0; }
  .side { padding: 3px 0 3px 10px; border-left: 2px solid var(--line); }
  .qid { color: var(--dim); }
  .versus { color: var(--mag); padding: 2px 0 2px 10px; font-size: 11px; letter-spacing: .5px; }
  .choose { padding: 4px 0 2px 10px; }
  /* Deliberately not styled as a primary action. Both choices are equally available and
     the page must not nudge: it does not know which statement is true. */
  button.pick {
    font: inherit; cursor: pointer; padding: 3px 10px;
    background: #1b2029; color: var(--fg); border: 1px solid var(--mag); border-radius: 2px;
  }
  button.pick:hover:not(:disabled) { background: var(--mag); color: #12151a; }
  button.pick:disabled { opacity: .5; cursor: default; }
  .banner.ok { background: #16301f; color: #7fd6a0; }

  .s-running, .s-queued { color: var(--blue); }
  .prov { margin-right: 10px; white-space: nowrap; }
  .prov.p-ok b { color: var(--green); font-weight: 600; }
  .prov.p-out b { color: var(--yellow); font-weight: 600; }
  .s-findings_ready, .s-awaiting_diff { color: var(--yellow); }
  .s-needs_human { color: var(--mag); }
  .s-passed { color: var(--green); }
  .s-passed_partial { color: var(--yellow); }
  .s-fast_clean { color: var(--blue); }
  .s-failed, .s-expired { color: var(--red); }
  .s-cancelled { color: var(--dim); }
  .empty { color: var(--dim); padding: 30px 4px; }
</style>
</head>
<body>
<header>
  <h1>lore</h1>
  <span><span class="k">build</span><span id="build" class="dim">—</span></span>
  <span id="providers"></span>
  <span><span class="k">model calls</span><span id="calls">—</span></span>
  <span><span class="k">open</span><span id="open">—</span></span>
  <span><span class="k">spend today</span><span id="spend">—</span></span>
  <span class="dim" id="live">connecting…</span>
</header>
<div id="banners"></div>
<!-- What a decision did, OUTSIDE the list. Deciding changes a review's state, which
     pushes a new snapshot and rebuilds every row — so a message written into the row is
     erased by its own success. The case that most needs reading survives least: "decided,
     and NOTHING resumed, because another contradiction still blocks these reviews". -->
<div id="told"></div>
<main>
  <div class="grid head" id="head" hidden>
    <span></span><span>state</span><span>branch</span>
    <span class="r">step</span><span class="r">used</span><span class="r">stalled</span>
  </div>
  <div id="board"><div class="empty">loading…</div></div>
</main>

<script>
// The last snapshot, kept so the per-second tick can recompute clocks without asking the
// server for anything. Rendering and ticking are deliberately separate: re-rendering the
// DOM once a second would destroy text selection and the caret position of anyone reading.
let snap = null;
// Which reviews the operator has opened. Rebuilding the list must not close them — a board
// that collapses what you were reading every time anything changes is unusable exactly
// when it is busy, which is when you are reading it.
const open = new Set();

const pad = (n) => String(n).padStart(2, "0");

/** Durations read at a glance: two units, largest first, never more. */
function dur(ms) {
  if (!isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (m < 60) return m + "m " + pad(s % 60) + "s";
  if (h < 24) return h + "h " + pad(m % 60) + "m";
  return Math.floor(h / 24) + "d " + pad(h % 24) + "h";
}

/**
 * How alarming a stall is, and it is deliberately not a fixed threshold per tier.
 * A t2 round legitimately runs 13 minutes here; 45 is the hang that started all of this.
 */
function stallClass(ms, terminal) {
  if (terminal) return "stall-ok";
  if (ms > 45 * 60000) return "stall-bad";
  if (ms > 20 * 60000) return "stall-warn";
  return "stall-ok";
}

const TERMINAL = new Set(["passed", "passed_partial", "failed", "expired", "cancelled"]);

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render(b) {
  document.getElementById("build").textContent = b.build.commit;
  document.getElementById("spend").textContent = "$" + b.spendTodayUsd.toFixed(2);
  // ONE CHIP PER ROUTE THE LADDER CAN SPEND. "ok" is the optimistic default and means
  // only "no refusal is on record" - a quota PERCENTAGE is not knowable from here, no
  // provider publishes one (D-84), so hours-to-reset is shown instead of a made-up
  // gauge. A tilde marks lore's own doubling guess; its absence marks a time the
  // provider itself named. Routes sharing a provider get the model appended so two
  // z.ai plans and three openrouter twins stay tellable apart.
  const provs = b.providers || [];
  const perProvider = {};
  provs.forEach((p) => { const k = p.route.split("/")[0]; perProvider[k] = (perProvider[k] || 0) + 1; });
  document.getElementById("providers").innerHTML = provs.map((p) => {
    const provider = p.route.split("/")[0];
    const label = perProvider[provider] > 1 ? provider + "\u00b7" + p.route.split("/").pop() : provider;
    let state = "ok";
    let cls = "p-ok";
    if (p.until) {
      const ms = Date.parse(p.until) - Date.now();
      const disp = ms <= 0 ? "now" : ms < 3600000 ? Math.ceil(ms / 60000) + "m" : Math.round(ms / 3600000) + "h";
      state = (p.stated ? "" : "~") + disp;
      cls = "p-out";
    }
    return '<span class="prov ' + cls + '" title="' + esc(p.route) + (p.until ? " \u2014 back " + esc(p.until) : "") + '">'
      + esc(label) + ' <b>' + esc(state) + "</b></span>";
  }).join("");
  // WHAT EVERY QUEUED REVIEW IS WAITING FOR. Rounds hold a worker while they wait here,
  // so a saturated gate is why nothing else starts — and without this line the board said
  // "queued 3" and left the reader to guess. A dash for a build with no gate: absent is
  // not zero.
  // Nothing queues behind this any more, so it is a measurement rather than a bound: how
  // many rounds are actually talking to a provider right now.
  const c = b.modelCalls;
  document.getElementById("calls").textContent = c ? String(c.inFlight) : "—";
  // THE ONLY QUEUE LORE HAS IS THE ONE AT THE DOOR. At the limit, review_start refuses —
  // so this is the number that says whether a client is about to be turned away, and it
  // goes red BEFORE that happens rather than after somebody is refused.
  const o = b.openReviews;
  // NOT named "open". That shadowed the module-level Set of expanded rows, so open.has
  // was called on a DOM element and threw — killing the rest of render() from that line
  // down, which included wiring up the decision buttons. Every row silently lost its
  // expanded state and no button did anything. Found by clicking one.
  const openEl = document.getElementById("open");
  openEl.textContent = o.open + "/" + o.limit;
  openEl.className = o.open >= o.limit ? "s-failed" : o.open >= o.limit * 0.75 ? "s-findings_ready" : "";

  const banners = [];
  // Drained reads as idle from outside and means the opposite: work arrives and nothing
  // claims it. Thirteen hours of that is why this line is first and loud.
  if (b.draining) {
    banners.push('<div class="banner drain">DRAINING — no new rounds are being claimed. ' +
      'Reviews queue and nothing runs them. <code>make drain-off</code></div>');
  }
  for (const t of b.tiersDown) {
    // Two marks, two consequences. Only a time the PROVIDER named stops reviews calling a
    // tier; lore's own guess bounds the background screen alone, and saying otherwise
    // reports degraded coverage that is not happening.
    banners.push('<div class="banner down">' + esc(t.tier) + (t.stated
      ? " IS NOT BEING ASKED — the provider named a reset time. Reviews use its fallback if one is configured, or step over it and say so."
      : " is rested by the knowledge screen — lore's own guess. REVIEWS STILL CALL THIS TIER normally.") +
      ' <span class="dim">until ' + esc(t.until.slice(0, 19)) + "Z — " + esc(t.why) + "</span></div>");
  }
  document.getElementById("banners").innerHTML = banners.join("");

  const main = document.getElementById("board");
  document.getElementById("head").hidden = b.reviews.length === 0;
  if (b.reviews.length === 0) {
    main.innerHTML = '<div class="empty">no reviews in the last two hours — lore is idle.</div>';
    return;
  }
  main.innerHTML = b.reviews.map(row).join("") +
    // Never a silent cap. Someone hunting a wedged review must not be shown a partial
    // list that looks complete.
    (b.reviewsNotShown > 0
      ? '<div class="banner down">' + b.reviewsNotShown +
        " more review(s) exist and are NOT listed here — this board shows the most recent " +
        b.reviews.length + ", unfinished work first.</div>"
      : "");
  for (const d of main.querySelectorAll("details")) {
    d.open = open.has(d.dataset.id);
    d.addEventListener("toggle", () => {
      if (d.open) open.add(d.dataset.id); else open.delete(d.dataset.id);
    });
  }
  for (const btn of main.querySelectorAll("button.pick")) btn.addEventListener("click", pick);
  tick();
}

function row(r) {
  const terminal = TERMINAL.has(r.state);
  // COLLAPSED CARRIES THE FOUR FACTS THAT MATTER: which step, whether anything is
  // actually working, how long in total, and how long since anything moved. Everything
  // else is a click away — but NOT the stall, which was behind a click and should never
  // have been: a board is read at a glance or it is not read.
  // "no tier" IS AN ALARM AND ONLY APPLIES TO A RUNNING REVIEW: nothing is working when
  // something should be. A queued review has no tier because it has not started, which is
  // ordinary — giving it the same yellow marker was the first thing that looked wrong on
  // the page, and an alarm that fires on the normal case is one nobody reads twice.
  const step = r.step
    ? '<span class="step">' + esc(r.step) + "</span>"
    : r.state === "running" && r.stepNote
      ? '<span class="nostep" title="' + esc(r.stepNote) + '">no tier</span>'
      : (terminal ? "" : '<span class="dim">—</span>');
  // A finished review's total time is FIXED. Ticking it up for days would say the review
  // is still spending time on this branch.
  const used = terminal && r.endedAt
    ? '<span class="clock dim">' + dur(Date.parse(r.endedAt) - Date.parse(r.createdAt)) + "</span>"
    : '<span class="clock dim" data-used="' + esc(r.createdAt) + '">—</span>';
  return '<details class="rev" data-id="' + esc(r.id) + '">' +
    '<summary class="grid">' +
      '<span class="caret">›</span>' +
      '<span class="state s-' + esc(r.state) + '">' + esc(r.state.toUpperCase()) + "</span>" +
      '<span class="branch" title="' + esc(r.branch) + '">' + branchLink(r) + "</span>" +
      '<span class="step-cell">' + step + '<span class="dim"> r' + r.round + "</span></span>" +
      used +
      '<span class="clock" data-stall="' + esc(r.movedAt) + '" data-terminal="' + terminal + '">—</span>' +
    "</summary>" +
    '<div class="body">' + detail(r) + "</div>" +
  "</details>";
}

function detail(r) {
  const out = [];
  if (r.stepNote) out.push('<div class="note">' + esc(r.stepNote) + "</div>");
  // WHY A PERSON IS NEEDED, first and in full. needs_human is the one state where
  // nothing in the system can proceed — not a tier, not a retry, not a sweep — so the
  // reader of this page is the mechanism. A label without the argument would leave them
  // to invent the question or drop it, which is what the MCP surface once did until a
  // client said it could not surface a question it was never given.
  if (r.state === "needs_human") out.push(question(r));
  out.push('<div class="dim">' + esc(r.id) + " · " + esc(r.type) + " · into " + esc(r.into) +
    " · started " + esc(r.createdAt.slice(0, 19).replace("T", " ")) + "Z</div>");

  if (r.tiers.length > 0) {
    out.push(r.tiers.map((t) => run(r, t)).join(""));
  } else {
    out.push('<div class="dim">no tier has been asked yet.</div>');
  }

  // Findings the (tier, round) grouping could not place. Normally none — and shown
  // rather than dropped, because where a finding is filed must never decide whether it
  // is seen.
  if (r.orphanFindings.length > 0) {
    out.push('<div class="run"><div class="run-head"><span class="skip">' +
      "not attributable to any tier attempt</span></div>" +
      '<div class="fs">' + r.orphanFindings.map((f) => finding(r, f)).join("") + "</div></div>");
  }

  const f = r.findings;
  out.push("<div>" +
    '<span class="sev-high">' + f.high + " high</span> · " +
    '<span class="sev-medium">' + f.medium + " medium</span> · " +
    '<span class="sev-low">' + f.low + " low</span>" +
    '<span class="dim"> · </span>' + f.open + " open" +
  "</div>");
  // Never a silent cap: a list that stops at forty reads as a complete list of forty.
  if (r.findingsNotShown > 0) {
    out.push('<div class="skip">' + r.findingsNotShown + " more finding(s) not shown here</div>");
  }

  // A check that did not run must never read as a check that found nothing (INV-1).
  for (const s of r.checksSkipped) out.push('<div class="skip">did not run: ' + esc(s) + "</div>");
  return out.join("");
}

/**
 * The branch, linked to its pull request when the client named one.
 *
 * The whole point of asking for the URL: a branch name is not clickable and does not say
 * which forge it lives on. Plain text when there is none, never a dead link.
 *
 * THE SCHEME IS CHECKED AGAIN HERE. review_start already refuses anything but http(s),
 * and this page is the reason that check exists — a stored javascript: URL would be
 * somebody else's script running in the operator's browser, on the one page they open
 * when something is wrong. Two checks because the rows predate the validation, and
 * because the cost of the second one is a regex.
 *
 * stopPropagation, or clicking the link also toggles the row open underneath it.
 */
function branchLink(r) {
  const name = esc(r.branch);
  if (!r.pullRequest || !/^https?:\\/\\//i.test(r.pullRequest)) return name;
  return '<a href="' + esc(r.pullRequest) + '" target="_blank" rel="noreferrer noopener"' +
    ' onclick="event.stopPropagation()">' + name + "</a>";
}

/**
 * The whole reason a review is parked on a person, spelled out.
 *
 * Two statements this repository believes that cannot both be true, each with where it
 * came from, and the two actions that end the block. Nothing here is summarised: a
 * paraphrase of one of these is a third statement, and the point of the state is that
 * only a human may choose between the two that exist.
 */
function question(r) {
  if (!r.openQuestions || r.openQuestions.length === 0) {
    // A REAL STATE AND A CONFUSING ONE: parked, with nothing left to decide. It means
    // the contradiction was resolved and nothing re-queued the review. Saying so beats
    // rendering an empty box, which reads as "the page is broken".
    return '<div class="human"><b>A PERSON IS NEEDED — but no contradiction is open any more.</b>' +
      " The question behind this block has been settled and nothing re-queued the review." +
      " It will sit here until somebody moves it or the sweep expires it.</div>";
  }
  return '<div class="human"><b>A PERSON MUST DECIDE THIS.</b> ' +
    "lore holds two statements about this repository that cannot both be true. It will not " +
    "guess between them, and no tier, retry or sweep can end this state." +
    r.openQuestions.map((q) => side(q, "left") + '<div class="versus">cannot both be true as</div>' + side(q, "right")).join("") +
    '<div class="dim">Choosing here IS the decision: the other statement is retired — kept in ' +
    "the database, never deleted — and every review parked on this question resumes, with its " +
    "client told that a person has already answered so it does not go and ask again. " +
    "knowledge_resolve does the same thing over MCP and records WHO decided, which a button on " +
    "a page with no login cannot.</div>" +
  "</div>";
}

/**
 * One statement, with the button that chooses it.
 *
 * THE BUTTON SAYS WHAT CHOOSING MEANS, not "left" or "right". A person arriving at this
 * page has not read the code, the ADR or the conversation that produced either statement —
 * the whole reason the state exists is that a judgement is needed — so the control has to
 * carry its own consequence: this one is right, the other is retired.
 */
function side(q, which) {
  const s = q[which];
  const other = q[which === "left" ? "right" : "left"];
  return '<div class="q">' +
    '<div class="side"><span class="qid">' + esc(s.id.slice(0, 8)) + "</span> " +
      esc(s.statement) +
      (s.source ? '<span class="dim"> — from ' + esc(s.source) + "</span>" : "") +
    "</div>" +
    '<div class="choose">' +
      '<button class="pick" data-repo="' + esc(q.repoId) + '" data-keep="' + esc(s.id) + '"' +
        ' data-retire="' + esc(other.id) + '" data-what="' + esc(s.statement) + '">' +
        "THIS one is right" +
      "</button>" +
      '<span class="dim"> — and retire the other</span>' +
    "</div>" +
  "</div>";
}

/** One tier attempt, with the findings it raised nested underneath. */
function run(r, t) {
  const running = !t.finishedAt;
  const mark = running ? '<span class="s-running">▸</span>'
    : t.outcome === "findings" ? '<span class="sev-medium">✓</span>'
    : t.outcome === "clean" ? '<span class="s-passed">✓</span>'
    // NOT a tick. A reused run did no work, and a tick beside "0s" invited exactly the
    // question that found this: it read as a full sweep that finished instantly.
    : t.outcome === "reused" ? '<span class="dim">↺</span>'
    : '<span class="s-failed">✘</span>';
  const took = running
    ? '<span class="clock s-running" data-used="' + esc(t.startedAt) + '">—</span>'
    : '<span class="dim">' + dur(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) + "</span>";
  // "raised nothing" rather than an empty space: a tier that ran and found nothing and a
  // tier whose findings are not being shown must not look the same (INV-1, again).
  // WHAT THIS ROW IS CLAIMING, and the reused case is the one that must not overclaim.
  // "raised nothing" about a run that did not happen is a check that did not run reported
  // as a check that found nothing — INV-1, in the page written to refuse it.
  const count = t.outcome === "reused"
    ? '<span class="dim">not re-run — the tree was unchanged, so the earlier sweep still stands</span>'
    : t.findings.length > 0
      ? '<span class="dim">' + t.findings.length + " finding(s)</span>"
      : running ? "" : '<span class="dim">raised nothing</span>';
  return '<div class="run"><div class="run-head">' +
      "<span>" + mark + " " + esc(t.tier) + "</span>" +
      '<span class="dim">round ' + t.round + "</span>" +
      "<span>" + took + "</span>" +
      '<span class="dim">' + esc(t.outcome ?? "running") + "</span>" +
      count +
    "</div>" +
    (t.findings.length === 0 ? "" :
      '<div class="fs">' + t.findings.map((f) => finding(r, f)).join("") + "</div>") +
  "</div>";
}

/**
 * One finding: a line collapsed, everything the tier said when opened.
 *
 * The id is review + fingerprint, so the open-set restores it across a push exactly as it
 * does for a review — reading a finding while the board updates must not close it.
 *
 * NO BACKTICKS ANYWHERE IN THIS FILE'S PAGE SOURCE. The whole page is one TS template
 * literal, so a backtick in a comment ENDS the string, and the compiler then reports the
 * confusion thirty lines later as a missing comma. Quoting an identifier the usual way
 * costs a syntax error that does not name its own cause.
 */
function finding(r, f) {
  const where = esc(f.file) + (f.line ? ":" + f.line : "");
  const tags =
    (f.settled ? '<span class="settled">' + esc(f.settled) + "</span> " : "") +
    (f.preexisting ? '<span class="pre">pre-existing</span> ' : "");
  return '<details class="f" data-id="' + esc(r.id + ":" + f.fingerprint) + '">' +
    "<summary>" +
      '<span class="sev-' + esc(f.severity) + '">●</span>' +
      '<span class="sev-' + esc(f.severity) + '">' + esc(f.severity) + "</span>" +
      '<span class="where">' + where + "</span>" +
      tags +
      '<span class="claim">' + esc(f.claim) + "</span>" +
    "</summary>" +
    '<div class="fbody">' +
      '<p><span class="label">evidence </span>' + esc(f.evidence) + "</p>" +
      '<p><span class="label">fails when </span>' + esc(f.failureScenario) + "</p>" +
      (f.settledBecause ? '<p><span class="label">settled </span>' + esc(f.settledBecause) + "</p>" : "") +
      '<p class="dim">' + esc(f.fingerprint.slice(0, 8)) +
        (f.symbol ? " · " + esc(f.symbol) : "") +
        (f.cwe ? " · " + esc(f.cwe) : "") +
        (f.preexisting ? " · the branch did not touch this file" : "") +
      "</p>" +
    "</div>" +
  "</details>";
}

/**
 * A person choosing one statement over the other.
 *
 * CONFIRMED FIRST, because this is the one control on the page that changes anything and
 * a second click cannot undo it: the losing statement is retired and every review parked
 * on the question resumes. The confirmation quotes what is being kept, so a misclick is
 * caught by reading rather than by regret.
 *
 * The buttons are disabled while the request is out. Two clicks would send two decisions,
 * and the second arrives to find no open conflict — an error message about something the
 * operator did successfully a moment ago.
 */
async function pick(e) {
  const btn = e.currentTarget;
  const box = btn.closest(".human");
  const keeping = btn.dataset.what;
  if (!confirm("Keep this statement and RETIRE the other?\\n\\n" + keeping +
      "\\n\\nEvery review waiting on this question resumes, and their clients are told a person decided.")) {
    return;
  }
  for (const b of box.querySelectorAll("button.pick")) b.disabled = true;
  // Written outside the list, which the next push rebuilds. See #told.
  const note = document.getElementById("told");
  try {
    const res = await fetch("/board/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: btn.dataset.repo,
        keep: btn.dataset.keep,
        retire: btn.dataset.retire,
      }),
    });
    const out = await res.json();
    if (!res.ok) {
      note.className = "banner down";
      note.textContent = "NOT decided: " + (out.error || res.status) +
        " — nothing was retired and every review is still parked.";
      for (const b of box.querySelectorAll("button.pick")) b.disabled = false;
      return;
    }
    note.className = "banner ok";
    // The COUNT, because "resolved" alone does not say whether anything moved — and it
    // legitimately may not have: another contradiction in the same repository keeps every
    // review parked, and reporting progress that is not happening is the thing this whole
    // page exists to refuse.
    note.textContent = out.resumed > 0
      ? "Decided. " + out.resumed + " review(s) resumed; their clients will be told a person answered."
      : "Decided, and NOTHING RESUMED: " + out.stillBlocking +
        " other contradiction(s) in this repository still block every review parked here.";
  } catch (err) {
    note.className = "banner down";
    note.textContent = "NOT decided: " + err + " — nothing was retired.";
    for (const b of box.querySelectorAll("button.pick")) b.disabled = false;
  }
}

/** Every clock on the page, recomputed from absolute timestamps the server sent. */
function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-used]")) {
    el.textContent = dur(now - Date.parse(el.dataset.used));
  }
  for (const el of document.querySelectorAll("[data-stall]")) {
    const ms = now - Date.parse(el.dataset.stall);
    el.textContent = dur(ms);
    el.className = "clock " + stallClass(ms, el.dataset.terminal === "true");
  }
}
setInterval(tick, 1000);

/**
 * The push stream.
 *
 * EventSource reconnects by itself, so the only thing worth writing here is what a
 * DISCONNECT looks like — because a board that stops updating while still showing numbers
 * is precisely the "healthy and doing nothing" failure this service exists to refuse.
 */
function connect() {
  const es = new EventSource("/board/events");
  const live = document.getElementById("live");
  es.onopen = () => { live.textContent = "live"; live.className = "dim"; };
  es.onmessage = (e) => {
    snap = JSON.parse(e.data);
    live.textContent = "live";
    live.className = "dim";
    render(snap);
  };
  es.onerror = () => {
    // Never silently: the clocks below keep ticking, and without this line they would
    // look like live data from a connection that has been dead for ten minutes.
    live.textContent = "DISCONNECTED — the numbers below are frozen";
    live.className = "s-failed";
  };
}
connect();
</script>
</body>
</html>
`;
