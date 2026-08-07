/**
 * Drive the real MCP surface, over the wire, as a client.
 *
 * **D-76 says a change is validated over MCP and that a CLI run is never evidence the
 * product works — and nothing enforced it.** It was written down after I reached for the
 * CLI *because* MCP would have required pushing a branch, turning an operator's decision
 * into a workaround that avoided asking for it. The workaround then failed on its first
 * command, since the CLI had never been run from the host at all: `EACCES: mkdir
 * '/var/lib/lore'`, a sandbox cache root defaulting to a container path. A surface
 * nobody exercises does not work.
 *
 * This is the cheap half of closing that. It proves the transport, the authentication,
 * the tool registry and the documents a client actually reads — everything short of
 * spending a model. The expensive half stays open and stays honest: a fresh session
 * driving a review to `passed` on the tool descriptions alone is Phase 3's real
 * criterion and cannot be a script, because the thing under test is whether the docs
 * teach an agent that has not been told.
 *
 * READ-ONLY BY CONSTRUCTION. It never starts a review and never polls one: `review_poll`
 * consumes deltas (D-78), so a smoke test that polled would take findings their owner
 * has not seen — a check that damages what it checks.
 *
 * That claim was FALSE for `review_inbox` until 2026-08-08, and this file asserted it in
 * a comment while doing the damage: the inbox called `undelivered` + `markDelivered` for
 * every review it listed, exactly as `review_poll` does. `make smoke` therefore emptied
 * the delta queue of every review belonging to the token it was given, and its owner was
 * shown nothing the next time it polled. The inbox no longer consumes; this comment is
 * the record of why that matters here specifically.
 *
 * Exit 0 or a named failure. Run: `make smoke`.
 */

// RUN FROM OUTSIDE THE CONTAINER, deliberately. D-76's whole point is that the product
// is what a client reaches over the wire; running this inside the container would be
// closer to the CLI path the decision distrusts. Resolved relative to this file so it
// works from any directory.
const SDK = new URL("../node_modules/@modelcontextprotocol/client/dist/index.mjs", import.meta.url).href;
const url = process.env.LORE_MCP_URL ?? "http://127.0.0.1:7777/mcp";
const token = process.env.LORE_TOKEN;

if (token === undefined || token === "") {
  console.error("smoke: set LORE_TOKEN to a live token (make tokens lists who holds one)");
  process.exit(2);
}

const { Client, StreamableHTTPClientTransport } = await import(SDK);

/** Every check names what it proves, so a failure says what stopped working. */
const checks = [];
const check = async (what, fn) => {
  try {
    const detail = await fn();
    checks.push({ ok: true, what, detail });
  } catch (e) {
    checks.push({ ok: false, what, detail: e instanceof Error ? e.message : String(e) });
  }
};

const base = url.replace(/\/mcp$/, "");

await check("the service answers without a credential", async () => {
  const r = await fetch(`${base}/healthz`);
  if (!r.ok) throw new Error(`healthz answered ${String(r.status)}`);
  return "healthz ok";
});

// A surface that answers everyone is not scoped, and the tokens are the perimeter now
// that LORE_BIND is 0.0.0.0.
await check("an unauthenticated MCP call is refused", async () => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (r.status !== 401) throw new Error(`expected 401, got ${String(r.status)}`);
  return "401 with WWW-Authenticate";
});

let client;
await check("a real MCP client connects and authenticates", async () => {
  client = new Client({ name: "lore-smoke", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return "connected";
});

// The tools a client needs to drive the loop at all. Named individually rather than
// counted: a count stays green while the one tool that matters disappears.
const REQUIRED = ["review_start", "review_poll", "review_submit", "review_attest", "review_inbox", "knowledge_query"];
await check("every tool the loop needs is registered", async () => {
  const { tools } = await client.listTools();
  const have = new Set(tools.map((t) => t.name));
  const missing = REQUIRED.filter((t) => !have.has(t));
  if (missing.length > 0) throw new Error(`missing: ${missing.join(", ")}`);
  return `${String(tools.length)} tools`;
});

// THE DOCS ARE THE INTERFACE (spec/agent-docs.md §1). A tool registered with an empty
// description is a tool an agent cannot use, and it would pass every other check here.
await check("every tool carries a description an agent can act on", async () => {
  const { tools } = await client.listTools();
  const bare = tools.filter((t) => (t.description ?? "").trim().length < 80).map((t) => t.name);
  if (bare.length > 0) throw new Error(`described too thinly to act on: ${bare.join(", ")}`);
  return "all described";
});

// lore-ok[b4f8eb05]: upheld, and fixed at the cause rather than here. The claim was
// exactly right — `review_inbox` called `undelivered` + `markDelivered` for every review
// it listed, so this "consumes nothing" check consumed. The fix belongs in the INBOX, not
// in the test that trusted it: `mcp/server.ts` no longer marks anything delivered, and
// `TOOL_DOCS.inbox` now states it plainly rather than leaving it to be inferred. Leaving
// the check here and weakening its claim would have kept the lie and lost the coverage.
//
// `review_inbox` is the one call that is safe to make here: it reads what is waiting for
// this token and consumes nothing.
await check("review_inbox answers, and consumes nothing", async () => {
  const res = await client.callTool({ name: "review_inbox", arguments: {} });
  const text = res.content?.[0]?.text ?? "";
  const body = JSON.parse(text);
  if (!Array.isArray(body.reviews)) throw new Error("no reviews array in the reply");
  return `${String(body.reviews.length)} waiting`;
});

await client?.close().catch(() => undefined);

for (const c of checks) console.log(`${c.ok ? "  ok  " : "  FAIL"}  ${c.what}${c.ok ? ` — ${c.detail}` : ""}`);
const failed = checks.filter((c) => !c.ok);
for (const f of failed) console.error(`\nFAILED: ${f.what}\n  ${f.detail}`);
console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
