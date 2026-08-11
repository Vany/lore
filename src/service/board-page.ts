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
  table.tiers { border-collapse: collapse; margin: 4px 0 8px; }
  table.tiers td { padding: 1px 14px 1px 0; white-space: nowrap; }
  .sev-high { color: var(--red); }
  .sev-medium { color: var(--yellow); }
  .sev-low { color: var(--dim); }
  .skip { color: var(--yellow); }
  .note { color: var(--yellow); }

  .s-running, .s-queued { color: var(--blue); }
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
  <span><span class="k">queued</span><span id="queued">—</span></span>
  <span><span class="k">in flight</span><span id="inflight">—</span></span>
  <span><span class="k">spend today</span><span id="spend">—</span></span>
  <span class="dim" id="live">connecting…</span>
</header>
<div id="banners"></div>
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
  document.getElementById("queued").textContent = b.queued;
  document.getElementById("inflight").textContent = b.inFlight;
  document.getElementById("spend").textContent = "$" + b.spendTodayUsd.toFixed(2);

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
  main.innerHTML = b.reviews.map(row).join("");
  for (const d of main.querySelectorAll("details")) {
    d.open = open.has(d.dataset.id);
    d.addEventListener("toggle", () => {
      if (d.open) open.add(d.dataset.id); else open.delete(d.dataset.id);
    });
  }
  tick();
}

function row(r) {
  const terminal = TERMINAL.has(r.state);
  // COLLAPSED CARRIES THE FOUR FACTS THAT MATTER: which step, whether anything is
  // actually working, how long in total, and how long since anything moved. Everything
  // else is a click away — but NOT the stall, which was behind a click and should never
  // have been: a board is read at a glance or it is not read.
  const step = r.step
    ? '<span class="step">' + esc(r.step) + "</span>"
    : r.stepNote
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
      '<span class="branch" title="' + esc(r.branch) + '">' + esc(r.branch) + "</span>" +
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
  out.push('<div class="dim">' + esc(r.id) + " · " + esc(r.type) + " · into " + esc(r.into) +
    " · started " + esc(r.createdAt.slice(0, 19).replace("T", " ")) + "Z</div>");

  if (r.tiers.length > 0) {
    out.push('<table class="tiers">' + r.tiers.map((t) => {
      const running = !t.finishedAt;
      const mark = running ? '<span class="s-running">▸</span>'
        : t.outcome === "findings" ? '<span class="sev-medium">✓</span>'
        : t.outcome === "clean" ? '<span class="s-passed">✓</span>'
        : '<span class="s-failed">✘</span>';
      const took = running
        ? '<span class="clock s-running" data-used="' + esc(t.startedAt) + '">—</span>'
        : '<span class="dim">' + dur(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) + "</span>";
      return "<tr><td>" + mark + "</td><td>" + esc(t.tier) + '</td><td class="dim">round ' + t.round +
        "</td><td>" + took + '</td><td class="dim">' + esc(t.outcome ?? "running") + "</td></tr>";
    }).join("") + "</table>");
  } else {
    out.push('<div class="dim">no tier has been asked yet.</div>');
  }

  const f = r.findings;
  out.push("<div>" +
    '<span class="sev-high">' + f.high + " high</span> · " +
    '<span class="sev-medium">' + f.medium + " medium</span> · " +
    '<span class="sev-low">' + f.low + " low</span>" +
    '<span class="dim"> · </span>' + f.open + " open" +
  "</div>");

  // A check that did not run must never read as a check that found nothing (INV-1).
  for (const s of r.checksSkipped) out.push('<div class="skip">did not run: ' + esc(s) + "</div>");
  return out.join("");
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
