# opencode integration

**Verified 2026-08-03.** Local versions read from disk; provider and server facts
fetched from `opencode.ai/docs`. `WebSearch` was unavailable all session (harness
error), so nothing here comes from search results.

Installed: **opencode 1.18.9** (`~/.nix-profile/bin/opencode`).
Config: `~/.config/opencode/opencode.json`.

---

## 1. Providers and subscriptions

> ⚠️ **This is the section with money attached.** See §1.4 — the docs contradict
> themselves. Verify at `/connect` before buying anything (TODO T1).

### 1.1 Z.AI / GLM

Docs describe a **"Z.AI Coding Plan"** option in `opencode /connect`, chosen when
you hold that subscription, plus an API key from the Z.AI console.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "zai": { "models": { "glm-4.7": { "name": "GLM-4.7" } } }
  }
}
```

### 1.2 OpenAI

Two auth paths documented:
- **ChatGPT Plus/Pro browser OAuth** — described as recommended.
- API key, entered manually.

Both via `/connect`; models then appear under `/models`.

### 1.3 OpenRouter

API key from the OpenRouter dashboard, pasted at `/connect`. Supports per-model
provider routing:

```json
{
  "provider": {
    "openrouter": {
      "models": {
        "moonshotai/kimi-k2": {
          "options": { "provider": { "order": ["baseten"], "allow_fallbacks": false } }
        }
      }
    }
  }
}
```

This is what `~/c/review` uses today for both models — pay-per-token.

### 1.4 ⚠️ Unresolved contradiction

The same docs page lists a subscription-style login for Z.AI ("Coding Plan") and
OpenAI (ChatGPT Plus/Pro OAuth), **and then states that all three providers are
pay-per-token**. Both readings cannot be true.

Two possibilities, neither confirmed:
- (a) the OAuth/Coding-Plan paths do bill against the subscription, and the summary
  sentence is sloppy; or
- (b) the login is subscription-based but API usage still bills per token.

**Do not buy on the strength of these docs.** Resolve at `/connect` with a real
account, and record the answer here. Which one is true decides whether the ladder
optimises quota (SPEC §2.1) or dollars.

### 1.5 Model names still to confirm

Taken from `~/c/review` and `oh-my-openagent.json`, **not** from a provider list:
`z-ai/glm-5.2`, `z-ai/glm-4.7`, `z-ai/glm-4.7-flash`, `openai/gpt-5.6-sol-pro`.
Confirm the exact identifiers under each subscription — they will differ from the
OpenRouter-prefixed forms.

---

## 2. Server and SDK

### 2.1 Server

```bash
opencode serve [--port <n>] [--hostname <host>] [--cors <origin>]
```

Defaults to `127.0.0.1:4096`. `OPENCODE_SERVER_PASSWORD` enables HTTP basic auth.
Architecture is client/server: the TUI is just one client, and the server exposes
an **OpenAPI 3.1 spec** at `/doc`, which is what the SDKs are generated from.

Vany's `opencode.json` already sets `server.port 4096`, `hostname 0.0.0.0`, mdns
on. `~/c/review` starts a second server on 4097 for its second model.

### 2.2 Endpoints of interest

| endpoint | purpose |
|---|---|
| `POST /session` | create (`parentID?`, `title?`) |
| `POST /session/:id/message` | prompt and wait (`model?`, `agent?`, `parts`) |
| `POST /session/:id/prompt_async` | prompt without waiting |
| `GET /session` | list |
| `GET /session/:id/message` | messages in a session |
| `POST /session/:id/compact` | compaction — **no CLI equivalent**, HTTP only |

Also documented: forking, aborting, sharing, reverting.

### 2.3 TypeScript SDK

```bash
npm install @opencode-ai/sdk
```

Generated from the OpenAPI spec, so session/model/agent/message-part types come
for free. Basis for SPEC D-3. **Latest is 1.18.11**, installs clean (verified
2026-08-03); the CLI on disk is 1.18.9, i.e. the same release train.

---

## 2.4 Local toolchain, verified 2026-08-03

| tool | version | path |
|---|---|---|
| node | 26.5.1 | `/opt/homebrew/bin/node` |
| bun | 1.3.14 | `/opt/homebrew/bin/bun` |
| deno | present | `/opt/homebrew/bin/deno` |
| npm | 11.17.0 | `/opt/homebrew/bin/npm` |
| pnpm | present | `/opt/homebrew/bin/pnpm` |
| tsc | 7.0.2 | `/opt/homebrew/bin/tsc` |
| git | 2.55.0 | `/opt/homebrew/bin/git` |
| jq | present | `~/.nix-profile/bin/jq` |
| gh | present | `/opt/homebrew/bin/gh` |

Node 26 strips types and runs `.ts` files directly, so this project has **no build
step**; `tsc --noEmit` is used purely as the typechecker. Note the contrast with
`~/c/review`'s environment note, which says bash 3.2 is *"the only bash on this
machine"* — the constraint that broke it does not apply here.

---

## 3. Local configuration as found

`~/.config/opencode/opencode.json`: plugins `opencode-claude-auth@latest` and
`oh-my-openagent@latest`; a `plane` MCP server (remote, API-key headers), with
`plane_*` tools disabled.

`~/.config/opencode/oh-my-openagent.json` maps named agents to models. Relevant
here:

| agent | model | note |
|---|---|---|
| `momus` | `anthropic/claude-opus-4-8` (max) | **the critic** — closest existing thing to a reviewer |
| `oracle` | `anthropic/claude-opus-4-8` (max) | |
| `sisyphus-junior` | `openrouter/z-ai/glm-4.7` | |
| category `deep` | `openrouter/z-ai/glm-5.2` | |
| category `quick` | `openrouter/z-ai/glm-4.7-flash` | candidate T0 |

`~/.config/opencode/agents/` contains exactly one file, `readonly.md` — the
read-only reviewer `~/c/review` creates. So the `oh-my-openagent` agents above are
defined **inside the plugin package**, not as local files, and a filename search
for `momus` under its `node_modules` directory turned up nothing obvious.

**Unverified:** `momus`'s actual prompt, and therefore whether it suits PR review.
TODO T4.

Note `momus` is currently Anthropic-backed — it would need repointing to satisfy
SPEC D-1 (reviewers must not share the author's model).

---

## 4. Open items

1. §1.4 — subscription vs pay-per-token. **Blocks purchase.**
2. §1.5 — exact model identifiers under each plan.
3. Rate limits per plan (requests/day, context size) — the ladder's whole cost
   model depends on these and no number is known yet.
4. Whether structured output is best obtained via a tool-call or a fenced JSON
   block through `/session/:id/message`.
5. `momus` suitability (§3).
