# Deployment and host constraints

Target host: **whatever the workgroup can reach.** Today that is a MacBook under Docker
Desktop, bound to `0.0.0.0` and reached over tailscale by three token holders.

**The Orange Pi was the target and was dropped 2026-08-07** (Vany's call), after the
laptop had been serving real reviews for four days and two colleagues were provisioned
against it. The design constraints it imposed are kept because they were right for
reasons that outlived it: the images are **arm64**, so a single-board host stays
available rather than becoming a port; nothing assumes a big machine; and concurrency
is sized from cores at runtime rather than written down, which is why moving hosts has
never required a config change. `PLAN.md` §4.1 keeps the measurements taken on RK3588 —
they were real, and they are history rather than a target.

---

## 1. The tokens are the perimeter

**Every version of this section has ended in the same place, by a different route.**
D-33 originally assumed a tailnet; the Orange Pi turned out not to have one, so the
bind defaulted to loopback and the tokens carried the load. The device is gone, the
laptop that replaced it *is* on a tailnet — and on 2026-08-07 `LORE_BIND` was set to
`0.0.0.0` on Vany's call, so the service answers on every interface it has.

The conclusion survives all of that, which is why it is the heading: **the bearer
tokens are the only thing between a caller and every repository lore knows about.**

- **`LORE_BIND` is a deliberate decision, recorded where it is made.** It defaults to
  loopback so that exposing the service is something somebody chooses; `lore/.env`
  carries the current value and the reason. `0.0.0.0` rather than the tailnet address
  specifically: pinning the tailnet IP fails to bind if it ever changes, and this
  laptop travels — so the honest statement is *every interface*, not *the safe one*.
- **This machine travels.** On any café or hotel wifi it joins, port 7777 answers.
  That is the cost of the bind, it was accepted knowingly, and it is why the sentence
  above is not decoration.
- **No public TLS, no domain, no certificate renewal.** TLS termination stays an outer
  concern; there is no proxy in front of this today.
- **Bearer tokens** (D-21, D-23, D-78) scope per repository, bind a review to the token
  that started it, and defend the network edge. Revocable: `make tokens` lists holders,
  `make revoke TOKEN=<short>` turns one off.
- **Abuse hardening is still absent** — no rate limit, no lockout, no request ceiling.
  It was a bet on the LAN and is now a bet on the tailnet plus a 32-byte CSPRNG token.
  It is the first thing to revisit, and more urgent than it was: three people hold
  tokens and the bind is open.

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

**The `tsc --incremental` row was aspirational until 2026-08-29 — the command
carried no such flag (D-134, which also has the three-round story: getting the
persistence location right — the obvious first choice, `/work`, turned out to
be torn down at the end of every single call — and then gating the flag on the
target's own TypeScript version, since `--incremental` with `--noEmit` is a
hard option error before TypeScript 4.0).** `checkTypes`'s bare `tsc --noEmit`
fallback (used when the target declares no `"typecheck"` script of its own) got
a full, uncached check every round regardless of the target's own
`tsconfig.json`, since `"incremental": true` is not TypeScript's default. Fixed
with `--incremental --tsBuildInfoFile /tsc-cache/tsc.tsbuildinfo`, where
`/tsc-cache` is a DEDICATED mount — `${scratchRoot}/${basename(worktree)}-tsc`
on the host — mirroring cargo's own `CARGO_MOUNT` (`/cargo-cache`) pattern
exactly, since neither existing mount can carry a value that must outlive one
call: `scratch` (`/work`) is deleted every round, and `cacheDir`
(`/work/node_modules`) is wiped by `npm ci` itself regardless of lore's own
teardown (verified directly). Keyed by `reviewId`, matching `scratch` itself —
never shared across repos or branches, since a `.tsbuildinfo` is a claim about
source content. Verified directly, not assumed: a bare `tsc --noEmit
--incremental` persists and correctly re-reads a `.tsbuildinfo`
(`--extendedDiagnostics` reports a non-zero "BuildInfo read time" on the second
run), an unchanged-but-still-broken file's error is RE-REPORTED every run rather
than suppressed as already-known, and a genuine fix correctly clears the cached
error on the next run — the one direction that would have silently weakened the
check. Gated on the target's own installed TypeScript version — read straight
from `cacheDir` on the host side, no container round-trip — since the flag
combination is a hard error before TypeScript 4.0 and `npx --no-install` runs
whatever the target has pinned, not lore's own. Scoped to the bare fallback
only: when the target declares its own `"typecheck"` script, lore has no safe
way to inject flags into an arbitrary target-defined command and does not try
— a monorepo's `turbo run typecheck` gets whatever incrementality IT already
has, nothing added. Cargo already had
the equivalent for free (`CARGO_ENV` points `CARGO_TARGET_DIR` at a persistent
mount that was never subject to `scratch`'s own teardown); this closes the same
gap for the one engine that did not already have it.

The install is itself arbitrary code execution (lifecycle scripts, with network), so
it belongs inside the sandboxed container (D-24), not in the service. That is true
even though nothing runs the tests: turning test execution off narrows the exposure
and does not remove it.

### 3.1 What actually bounds concurrency

**Nothing throttles below admission any more** (D-98, D-101). A review is refused at the
door when 128 are already open; everything admitted is claimed and started at once. There
is no model-call semaphore and no worker pool, and the two variables that used to set them
— `LORE_MODEL_CONCURRENCY` and `LORE_CONCURRENCY` — are **deleted**. The service refuses to
start if either is still set, because a knob wired to nothing is decoration a reader
believes.

**Read the measurement below as history, not as a setting to change.** It is why both
bounds existed and what removing them costs.

Measured on 2026-08-05 at 12 concurrent rounds, on a host with 16 cores and 48 GB behind a
Docker VM of 14 cores and **7.7 GB**:

- **Memory held.** Six concurrent sandboxes against 6 GB limits each used 1–3 GB apiece,
  peaking near 84% of the VM. Limits are ceilings, not reservations. When it is wrong it is
  wrong loudly: an OOM-killed sandbox exits 137 and is reported as *did not finish*, never
  as a clean check.
- **The npm cache did not, and had to be fixed.** It is keyed by lockfile hash, so every
  branch of a repository that has not changed its lockfile shares one `node_modules`
  mounted read-write into each sandbox. Installs sharing a cache directory are serialised
  now — a warm install measures ~200ms, and the cold one happens once — because a
  half-written `node_modules` makes `tsc` and `eslint` report errors that are not real.
- **The provider was the real ceiling.** Four reviews died within 2.5 minutes: two `socket
  hang up` in the same second, two empty replies inside a 200. That is the upstream
  refusing the load, and the one constraint neither the host nor the container could show.
  They failed honestly — `this review DID NOT RUN` — but the quota was spent.

The lesson that survives is the shape: **one knob governing two resources with different
limits will always be wrong for one of them.** The answer is no longer a second knob. It is
that queueing invisibly is worse than either — a drain flag left set cost thirteen hours of
eight people's reviews, and a round waiting for a model slot was indistinguishable from a
round that was wedged.

**So the ceiling is now the machine, and it is visible rather than configured.** The board
reports rounds in flight and model calls in flight; t0's p90 is 537 seconds of sandboxed
install on sixteen cores. If provider faults return, the levers are the tier configuration
and the admission limit — that is a consequence taken deliberately, and it is recorded in
D-98 and D-101 rather than left for someone to discover.

`/status` reports `model_calls` as `{ inFlight }` — a measurement, with no limit and
nothing waiting, because nothing queues there any more.

## 4. Resources

| resource | note |
|---|---|
| 32 GB RAM | generous for an SBC; several parallel test containers fit |
| 4 TB disk | ample for bare clones, worktrees, `node_modules` caches, SQLite + backups |
| CPU | **the scarce resource.** Scheduling is CPU-bound, not memory-bound |

Disk being plentiful is what makes aggressive caching the right trade: spend 4 TB to
save CPU, because CPU is what there is least of.

## 4.1 The database is in a volume; everything else is a host bind

Two storage requirements that point in opposite directions, so there are two mounts.

**`LORE_DATA_DIR` must be a host bind, at the identical path on both sides.** The T0
sandbox asks the host daemon to bind a worktree into a sibling container by absolute
path, and the daemon resolves that path on the HOST — a named volume would mount an
empty directory and the suite would report clean for code it never saw. Worktrees, git
mirrors and the sandbox npm cache all live there.

**`LORE_DB_DIR` must NOT be, and that is what changed on 2026-08-08.** On Docker Desktop
for macOS a bind is virtiofs — the container reports it as `fakeowner` over
`/run/host_mark` — and SQLite's own `howtocorrupt.html` §2.1 names a filesystem with
unreliable locking primitives, plus two or more processes sharing the file, as a cause of
corruption. lore and litestream are those two processes. This database was corrupted
**three times in three days**, and the damaged b-tree was `knowledge` every time, which
is the table a review bulk-writes during doc ingest.

So `lore.db` lives in the `lore-db` named volume: ext4 inside the Linux VM, where locking
is ordinary kernel locking and two processes sharing a SQLite file is the supported
arrangement it has always been.

**Nothing operational is lost by the database having no host path**, because the thing a
person carries away was never the database — it is the replica, and that stays a host
bind. What did need answering is the down case: `make db-check` and `make replica-state`
have to work while lore is *not running*, since that is when they are asked. They use a
throwaway container against the volume, which is strictly better than the `compose exec`
they used before — a crash-looping service could not exec, so the check that says *your
database is unreadable* was unreachable in the one state it exists for.

**One definition of where it lives.** `LORE_DB_DIR` is set in the image and in compose;
the CLI resolves `LORE_DB_DIR`, then `LORE_DATA_DIR`, then `~/.lore`, in the same order
the service does, and the Makefile passes no `--db` at all. A second copy of that decision
in a Makefile is how `make revoke` came to answer *unable to open database file* at the
moment an operator was killing a leaked credential. Every CLI command that READS existing
state now refuses a database that does not exist rather than creating an empty one — a
command that could not look must not report as a command that found nothing.

## 4.2 `deploy/` is tracked; the deployment is a copy, and copies drift

The deployment directory is gitignored (it holds the knowledge base and every reviewed
worktree), so `deploy/` in the repository and the deployment beside it are two copies of
one decision. On 2026-08-08 they had diverged in **both** directions: `make knowledge` and
`make smoke` existed only in the deployment, and so did the `replica-state` fix that reads
the database's own write log instead of file mtimes. An evening was spent editing the
tracked copy while deploying the other, and the volume change appeared to do nothing —
compose was reading a file that had not been touched.

The near-miss is the reason this is written down: porting the change onto the stale copy
would have silently reverted the replica-state fix, in the monitor that exists to stop the
wolf-crying.

`make up` now refuses when the two differ, naming the files, and `make sync-deployed`
takes the repository's version — deliberately, never automatically, because the deployment
has twice held the newer copy. Skipped where no repository sits beside the deployment,
which is every remote host; there `make push` is what keeps them equal.

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

Litestream replicates the **volume**, and writes its replica to the host bind — which is
the only crossing that remains, and it is a directory of append-only segments rather than
a database being locked.

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

    make mirror-daemon        resident: a full pass every five minutes, and on demand
    make mirror-daemon-log    what it last did
    make mirror REPO=<name>   one repository, by hand

**And lore can ASK for a fetch** (D-100). A client that pushes and immediately starts a
review is doing exactly what the docs tell it to, and used to lose: a branch pushed 77
seconds before `review_start` was not in the mirror yet, so the review died as `failed` —
which by INV-1 means the ladder did not read the code. lore still holds no credentials, so
it does not fetch; it drops a request in the shared data directory, and this process — the
one that has the credentials — does the fetch and deletes the request to say it is done.
The channel is the data bind, mounted at the same absolute path on both sides, which is the
only thing the two already agree on: no port, no secret.

That is why the daemon is now **resident** rather than a five-minute one-shot: a request
dropped by a review would otherwise wait for the next tick, which is the delay it exists to
remove. Between full passes it answers requests within two seconds and stamps a heartbeat.
**The heartbeat is what makes a dead daemon fast instead of slow** — without it, a request
nobody consumes is indistinguishable from a fetch in progress, and every review would wait
its whole timeout before failing. Measured end to end on this host: request noticed in
under a second, both repositories fetched, answered in seven.

Upgrading requires re-running `make mirror-daemon`: an older agent still on a timer never
sees a request. lore says so rather than hanging.

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
