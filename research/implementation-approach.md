# Implementation approach — how this is built in 2026

**Verified 2026-08-03.** MCP SDK facts from the official TypeScript SDK repo and
`modelcontextprotocol.io` docs (protocol revision `2026-07-28`). Versions from
`npm view`. Container tooling checked locally. Where this document gives an
opinion rather than a fact, it says so.

---

## 1. The MCP server stack

The SDK was **renamed**. It is no longer `@modelcontextprotocol/sdk`:

| package | version | role |
|---|---|---|
| `@modelcontextprotocol/server` | **2.0.0** | the server itself |
| `@modelcontextprotocol/node` | 2.0.0 | Node HTTP adapter |
| `@modelcontextprotocol/hono` | 2.0.0 | Hono adapter |
| `@modelcontextprotocol/express`, `/fastify` | 2.0.0 | other adapters |
| `zod` | 4.4.3 | schemas |

The adapters are described as *"intentionally thin adapters"* with no business
logic — so the choice between them is not load-bearing.

Tools are declared with **Standard Schema** (Zod v4, Valibot or ArkType):

```ts
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'

const server = new McpServer({ name: 'lore', version: '0.1.0' })

server.registerTool(
  'review.start',
  {
    description: 'Begin a review of branch against into',
    inputSchema: z.object({ branch: z.string(), into: z.string() }),
  },
  async ({ branch, into }) => ({ content: [{ type: 'text', text: '…' }] }),
)
```

This matters for `PROG.md`: schemas are declared once and both validate at runtime
and generate the TypeScript types. No hand-written parsing at the boundary.

---

## 2. State handle hijacking — a named attack against our design

The MCP security guidance describes this attack, and **`review_id` is exactly the
handle it is about**:

> MCP is stateless and has no protocol-level sessions. Servers that need state
> spanning multiple requests mint an explicit handle […] and receive it back as an
> ordinary tool argument on each request. State handle hijacking is an attack
> vector where an unauthorized party obtains or guesses such a handle and uses it
> to access or modify another user's state.

Requirements, quoted:

> MCP servers that implement authorization **MUST** verify all inbound requests.
> MCP servers **MUST NOT** treat possession of a state handle as authentication.

> MCP servers **SHOULD** use secure, non-deterministic handles generated with
> secure random number generators. Avoid predictable or sequential identifiers.

> MCP servers **SHOULD** bind handles server-side to the authenticated user, for
> example by keying stored state as `<user_id>:<handle>` where the user ID is
> derived from the verified token rather than supplied by the client.

Applied to `lore`: `review_id` is CSPRNG-generated, never sequential, and every
`review.poll` / `review.submit` / `review.attest` re-verifies the bearer token
**and** that the review belongs to that token's principal. A valid `review_id` from
another tenant must fail exactly as an invalid one does.

This is cheap to build now and expensive to retrofit — the moment a sequential id
is stored anywhere, every log line becomes a credential.

## 3. Other applicable requirements

- **Token passthrough is forbidden.** *"MCP servers MUST NOT accept any tokens that
  were not explicitly issued for the MCP server."* Our bearer tokens are minted by
  us, scoped per repo, and never forwarded anywhere.
- **Scope minimization.** Least privilege, incremental elevation. Our tokens are
  repo-scoped from the start; there is no `full-access` token.
- **Sandboxing for spawned processes**, restricted filesystem access, and logging
  of process execution are all called out. See §4.

---

## 4. Executing the target's test suite

T0 runs the repo's own tests, which is **arbitrary code execution**. `npm test`
runs whatever the repo and its dependency tree say, including lifecycle scripts.

**The threat is not the teammate; it is the dependency tree.** A compromised
transitive package is a live risk in any Node repo, and the reviewer is a
particularly attractive target because of what sits next to it.

### 4.1 The service container must not be the test container

This is my recommendation, not a quoted requirement, and it is the single most
important structural point in this document.

The service holds the **deploy keys for every registered repo** and the
**knowledge database**. If a test suite runs in that container, one malicious
`postinstall` reads both — every repo's source, every private key, all at once.

So: tests run in a **separate, ephemeral container per review**, which has

- **no secrets mounted** — no deploy keys, no tokens, no database,
- **no network**, or egress through a deny-by-default proxy,
- a read-only root filesystem apart from the worktree,
- CPU, memory and PID limits, and a hard timeout,
- and is destroyed after the run.

The review worktree goes in; findings come out. Nothing else crosses.

### 4.2 Available locally

`docker` and `podman` are both installed (`~/.nix-profile/bin`). No gVisor,
runsc or Firecracker.

Plain containers are a **namespace** boundary, not a virtualisation boundary — a
kernel exploit escapes them. For a workgroup running its own code that is a
proportionate trade, and it should be a conscious one. Podman rootless narrows the
blast radius further at no real cost.

**A timeout is mandatory, not a nicety.** A hung test suite otherwise occupies a
review slot forever, and the failure looks like a slow review rather than a stuck
one.

---

## 5. Build order: walking skeleton

**Recommendation, on general engineering practice rather than a fetched source.**

Build a thin vertical slice that runs end to end, then deepen it — rather than
completing each horizontal layer in turn. Concretely: core → git → opencode → T0 →
**a CLI that performs one real review** → then wrap in MCP, Docker and
provisioning.

Reasons specific to this project:

1. **The CLI is the debugger.** Every hard part — agentic reviewing, structured
   output, escalation, ledger reconciliation — is far easier to iterate on without
   HTTP, containers and tokens in the loop. `D-16` already makes the CLI the
   development surface; this just builds it first.
2. **It is usable early.** A working CLI replaces `~/c/review` weeks before the
   service exists, and real use is what surfaces the design errors.
3. **The uncertainty is in the review, not the plumbing.** MCP servers, job queues
   and Docker are known quantities. Whether a three-tier ladder converges on real
   branches is not. Build the risky part where it is cheapest to change.

The counter-argument, honestly: the service has genuine integration risk of its own
(scheduling, concurrency, token handling), and building it later means discovering
that later. The mitigation is that the core stays host-agnostic (D-4), so the
service wraps it rather than reaching into it.

---

## 6. Open items

1. Whether `node:sqlite` handles the write concurrency of parallel reviews plus
   parallel `knowledge.*` calls under WAL, or whether writes need funnelling
   through a single writer. **Untested.**
2. Job scheduling: an in-process queue is enough for one container, but it dies
   with the process. Durable queue state belongs in the same SQLite database so a
   restart resumes rather than forgets.
3. gVisor/Firecracker if the trust model ever widens beyond the workgroup.
4. Whether to adopt full OAuth 2.1 later; opaque revocable tokens are proportionate
   now.
