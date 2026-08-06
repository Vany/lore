# Deployment and host constraints

Target host: **Orange Pi, 32 GB RAM, 4 TB disk** — an **arm64 single-board
computer**, and both halves of that phrase constrain the design. What runs today is
those images on a MacBook under Docker Desktop; the device is still open in `TODO.md`.

---

## 1. There is no Tailscale, so the tokens are the perimeter

**The design assumed a tailnet and the host does not have one** (D-33, revised
2026-08-03; `PLAN.md` §4.1 records the check as `tailscale on host — ABSENT`). The
device sits physically in the operator's hands on a private LAN, which is a real
perimeter but not a cryptographic one.

So the compose bind **defaults to loopback**: exposing the service is a decision
someone makes on purpose, by setting `LORE_BIND`. And the bearer tokens stop being
mere scoping and do the load-bearing work — they are the only thing between a machine
on the LAN and every repository lore knows about.

- **No public TLS, no domain, no certificate renewal.** Not because WireGuard
  provides transport security, but because the service is not reachable from outside
  the LAN at all. TLS termination stays an outer concern.
- **Bearer tokens** (D-21, D-23) scope per repo *and* now defend the network edge.
  They are revocable — `make tokens` lists them, `make revoke TOKEN=<short>` turns one
  off — which matters more here than it would behind a tailnet.
- **Abuse hardening is still absent**, and that is a bet on the LAN rather than a
  reasoned defence. It is the thing to revisit first if `LORE_BIND` ever widens.

Getting the tailnet perimeter back costs one line in `.env` plus installing
tailscale. Revisit when the device leaves the operator's possession, or when a second
workgroup member needs access from elsewhere.

## 2. arm64 is a hard constraint

- Every image — service **and** test containers — must be `linux/arm64`.
- Node, Bun and `ast-grep` all ship arm64 builds. Fine.
- **The risk is the target repos' own dependencies.** A Node project whose tree
  contains a package shipping x86-only prebuilt binaries will fail to **install** on
  this host, through no fault of ours.

Verified 2026-08-03 on the device (`PLAN.md` §4.1): node runs natively, `npm ci`
takes 9 s, the suite 7 s, a typecheck 2 s. The one real finding was that
`node:*-alpine` ships **no git**, which failed 10 tests in the way that matters most
— not by refusing to run, but by running and producing failures unrelated to the
change, which T0 would have reported as high-severity findings.

An install failure still costs real engines. lore does not execute a suite (D-71),
but `tsc` and `eslint` resolve their binaries out of the target's `node_modules`, so
a tree that cannot install on arm64 silently removes both — reported as
`checks_skipped`, never as a clean check.

## 3. T0 is the throughput bottleneck, not the models

An inversion worth stating plainly: **model calls are remote and cost this host
almost nothing. T0 is local, CPU-bound, and runs on modest ARM cores.** The "free"
tier is the one that costs wall-clock.

Budget at 30 PRs/day, solo:

```
30 PRs × ~5 rounds × (install? + tsc + eslint)
```

**Measured, and the estimate was an order of magnitude too pessimistic in our
favour.** D-37 guessed ~5 CPU-hours/day; a T0 round on this repo is ~2 s of typecheck
with installs cached, so 30 PRs × 5 rounds is **~25 minutes/day**. T0 is still the
local bottleneck and the caching below is still worth having, but it is not the
constraint the plan feared. Caveat: lore is a small repo; a large monorepo is slower.

The suite is **not** in that formula. lore reads a test suite and never runs one
(D-71), so the heaviest thing T0 could have done here is gone — which is most of why
the measured figure landed where it did.

So T0 is engineered for this host rather than merely invoked:

| technique | why |
|---|---|
| `node_modules` cache keyed by lockfile hash | a fresh install per review would dominate everything |
| `tsc --incremental` with a persisted build info cache | full typecheck every round is pure waste |
| **diff-scoped work on rounds ≥ 2** | round 1 checks everything; later rounds re-check what changed and its dependents |
| bounded concurrency | see §3.1 — the binding constraint turned out to be neither |

**Round 1 is thorough; later rounds are incremental.** Without that, the ladder's
"reset to T1 after every fix" (D-6) multiplies the most expensive local work by the
round count.

The install is itself arbitrary code execution (lifecycle scripts, with network), so
it belongs inside the sandboxed container (D-24), not in the service. That is true
even though nothing runs the tests: turning test execution off narrows the exposure
and does not remove it.

### 3.1 What actually bounds concurrency

`LORE_CONCURRENCY` governs both halves of a round, and they have opposite constraints.
The model call is remote and merely waits — t1 averages 304s, t2 915s. T0 runs a
sandbox container locally and is CPU- and memory-bound. Raising the number buys real
throughput on the waiting half and oversubscribes the local one.

Measured on 2026-08-05 at 12, on a host with 16 cores and 48 GB behind a Docker VM of
14 cores and **7.7 GB**:

- **Memory held.** Six concurrent sandboxes against 6 GB limits each used 1–3 GB
  apiece, peaking near 84% of the VM. Limits are ceilings, not reservations. When it
  is wrong it is wrong loudly: an OOM-killed sandbox exits 137 and is reported as *did
  not finish*, never as a clean check.
- **The npm cache did not, and had to be fixed.** It is keyed by lockfile hash, so
  every branch of a repository that has not changed its lockfile shares one
  `node_modules` mounted read-write into each sandbox. Installs sharing a cache
  directory are serialised now — a warm install measures ~200ms, and the cold one
  happens once — because a half-written `node_modules` makes `tsc` and `eslint` report
  errors that are not real.
- **The provider was the real ceiling.** Four reviews died within 2.5 minutes of the
  change: two `socket hang up` in the same second, two empty replies inside a 200.
  That is the upstream refusing the load, and the one constraint neither the host nor
  the container could show. They failed honestly — `this review DID NOT RUN` — but the
  quota was spent.

The lesson is the shape rather than the number: **one knob governing two resources
with different limits will always be wrong for one of them.**

**Built, 2026-08-06.** `LORE_MODEL_CONCURRENCY` (default 4) bounds model calls in
flight across every review, separately from `LORE_CONCURRENCY`, which stays sized for
T0 by cores. Work above the limit **queues rather than failing** — the same argument
as backpressure in `spec/mcp-api.md` §5, since a review that dies on a 429 is a review
that did not run.

The bound is held for the whole **session**, not per request: what loads a provider is
the agentic exploration between the prompt and the reply, and an agent re-sends its
accumulated context on every turn (D-50), so gating individual HTTP calls would bound
nothing. One `Reviewer` is shared by every worker loop for the same reason — one per
loop would give each its own gate and the limit would silently multiply by the worker
count, reading as 4 and behaving as 48 at `LORE_CONCURRENCY=12`.

Four is sized from the failure rather than guessed: 12 killed four reviews, and the
deployment has been healthy at 2. `/status` reports `model_calls` — in flight, waiting,
limit — because queueing and running look identical from outside, which is the whole of
D-26, and until this existed the remote half could not queue at all. It just died.


### 3.2 The tier files, and one that is not a ladder

`LORE_TIERS` points at a tiers file that overrides the default ladder entirely
(`spec/review-ladder.md` §1).

| file | what it is |
|---|---|
| `tiers.zai-kimi-openai.json` | **the deployment's ladder** — Z.ai, Moonshot, OpenAI, one vendor per tier (D-74) |
| `tiers.zai-openai.json` | the previous two-vendor ladder, kept for reference |
| `tiers.kimi.json` | **not a ladder.** T0 plus Kimi alone, to exercise one tier deliberately |

`tiers.kimi.json` exists because Kimi is T2 and every review either settled at t1 or
failed before escalating, so a tier that was configured had never executed — and a
tier that has never executed is not a working tier. Putting it first is the only way
to make it run.

**It cannot reach `passed`, by construction**: every model tier in it is Moonshot, so
D-49 applies and `passed_partial` is the ceiling. That is correct and it is why this
must never be the deployment's ladder. It is written here rather than in the file
because the tier schema is `.strict()` and JSON has no comments — the same problem
D-57 solved for justifications, and the reason a reader has to be told somewhere.

## 4. Resources

| resource | note |
|---|---|
| 32 GB RAM | generous for an SBC; several parallel test containers fit |
| 4 TB disk | ample for bare clones, worktrees, `node_modules` caches, SQLite + backups |
| CPU | **the scarce resource.** Scheduling is CPU-bound, not memory-bound |

Disk being plentiful is what makes aggressive caching the right trade: spend 4 TB to
save CPU, because CPU is what there is least of.

## 5. Backups

SQLite plus Litestream (SPEC §3). The Pi is a single machine with no redundancy, and
the knowledge base is the product — losing it loses everything the workgroup has
taught the service.

**The split (D-59).** Litestream writes a continuously-restorable **local** file
replica beside the deployment; an outer script carries it off the machine. The
boundary is deliberate: lore owns the half it can be responsible for without holding
any credential, and a container with no S3 key cannot leak one. Always on — no
profile, no credentials, nothing to forget to enable.

A copy on the same disk is **not a backup**. It survives a corrupted database, a bad
bulk write and a wrong `down-hard`; it does not survive the disk. `make backup-check`
reports the local half only, and says so.

**Restore is tested, not assumed.** `make backup-drill` restores from a copy with the
source destroyed first. The drill uses `VACUUM INTO`: a WAL database copied with `cp`
loses whatever is still in the write-ahead log.

**Staleness is measured as BEHIND THE DATABASE, never as "not written recently".**
litestream writes only when there is something to replicate, so an idle database and
a dead replicator are identical under a freshness test — and the freshness form cried
wolf the first time it mattered, on a replica that was perfectly level. Both readers
now compare the replica against the database: `deploy/Makefile`'s `replica-state` for
`make status`, which has to answer while the service is down, and `ops/heartbeat.ts`
for the devops page. The threshold exists once in TypeScript and
`one-definition.test.ts` fails if the shell copy drifts from it.

The page is what changed on 2026-08-06. `spec/operations.md` §2.1 had listed the
replica under *someone should look now* since it was written, and nothing ever sent
it: the only check lived in `make status`, which is a command a human runs. lore now
mounts the replica folder read-only and beats on it. A deployment that does not mount
it reports `replica: "unconfigured"` — the check could not run, which is not the same
as passing.

## 6. The mirror is refreshed by a host process (D-65)

Nothing outside the deployment directory is mounted into the container — not a
checkout, not a key, not an agent socket. `deploy/mirror-refresh.sh` runs on the HOST,
as the operator, and clones or fetches every registered repo into
`data/repos/<id>/bare.git`, which lore already reads.

    make mirror-daemon        every five minutes, launchd or systemd --user
    make mirror-daemon-log    what it last did
    make mirror REPO=<name>   one repository, by hand

**The reviewer container sees the repositories and nothing else.** It runs
third-party models with file-reading tools, as the same uid as `lore` — it must, since
it writes its own session state — so mounting the data root handed a reviewer the
attestation signing key, `lore.db` and every credential beside them. Checked rather
than assumed on 2026-08-05, and the assumption was wrong: all three were readable from
inside it. It mounts `data/repos` only, which is all a worktree needs.

It reads the repository list straight out of the SQLite registry, read-only, so it
keeps working while lore is down, restarting or being rebuilt — which is exactly when
a stale mirror would otherwise go unnoticed.

This is what lets the service hold no git credentials at all. The cost is that lore
cannot tell whether the timer is alive, so `make status` prints every mirror's age and
turns red at the same threshold that refuses a review.

**On macOS the LaunchAgent runs in the login session**, which is what makes the
keychain available — a passphrase-protected key works there and would not in a
system-wide daemon. On Linux, `systemctl --user` needs `loginctl enable-linger` to run
while logged out, and a key the agent does not have to unlock.
