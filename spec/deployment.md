# Deployment and host constraints

Host: **Orange Pi, 32 GB RAM, 4 TB disk, on Tailscale (WireGuard), reachable to
prod.** That is an **arm64 single-board computer**, and both halves of that phrase
constrain the design.

---

## 1. Tailscale removes a whole category of work

The service is never publicly exposed. It listens on the tailnet only.

- **No public TLS, no domain, no certificate renewal.** WireGuard already provides
  the transport security. TLS termination is an outer concern and deliberately not
  this project's problem.
- **No abuse surface.** Rate limiting, bot defence and public-facing hardening are
  not needed; the network boundary does that job.
- **Bearer tokens still apply** (D-21, D-23) — not for network defence, but for
  **per-repo scoping** and for binding `review_id` to a principal. Two teammates on
  the same tailnet still should not read each other's repos by guessing an id.

## 2. arm64 is a hard constraint

- Every image — service **and** test containers — must be `linux/arm64`.
- Node, Bun and `ast-grep` all ship arm64 builds. Fine.
- **The risk is the target repos' own dependencies.** A Node project whose tree
  contains a package shipping x86-only prebuilt binaries will fail to install or
  test on this host, through no fault of ours.

**This must be verified early** (TODO T0.5). If the workgroup's repos cannot install
and test on arm64, D-24 (T0 executes tests) is not deliverable on this host, and the
options are cross-architecture emulation — brutally slow — or a different host. It
would be expensive to discover after building the whole sandbox.

## 3. T0 is the throughput bottleneck, not the models

An inversion worth stating plainly: **model calls are remote and cost this host
almost nothing. T0 is local, CPU-bound, and runs on modest ARM cores.** The "free"
tier is the one that costs wall-clock.

Rough budget at 30 PRs/day, solo:

```
30 PRs × ~5 rounds × (install? + tsc + eslint + tests)
```

If T0 takes two minutes per round, that is **~5 hours of CPU per day** for one
developer. On a handful of ARM cores this is feasible but tight, and a burst of PRs
will queue. With the workgroup it does not fit.

So T0 must be engineered for this host, not merely invoked:

| technique | why |
|---|---|
| `node_modules` cache keyed by lockfile hash | a fresh `npm install` per review would dominate everything |
| `tsc --incremental` with a persisted build info cache | full typecheck every round is pure waste |
| **diff-scoped work on rounds ≥ 2** | round 1 checks everything; later rounds re-check what changed and its dependents |
| test selection by changed files, where the repo supports it | running the full suite five times per PR is the worst case |
| bounded concurrency | 32 GB allows several containers; the CPU does not |

**Round 1 is thorough; later rounds are incremental.** Without that, the ladder's
"reset to T1 after every fix" (D-6) multiplies the most expensive local work by the
round count.

The `npm install` step is itself arbitrary code execution (lifecycle scripts), so it
belongs inside the sandboxed test container (D-24), not in the service.

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

**Revised by D-59.** This section said the replication target must be off-device,
and Litestream now writes a **local** file replica beside the deployment, from which
an outer script takes it off the machine. The reasoning holds — a backup on the same
disk is not a backup — but the boundary moved: lore's job is a continuously
restorable copy, and getting it off the box is the operator's, with no credentials
inside the container to do it. The replica is always on: no profile, no S3 key.

**Restore is tested, not assumed.** `make backup-drill` restores from a copy with
the source destroyed first, and `make status` says so loudly when the replica has
not been written in an hour. That check exists because copying a WAL database with
`cp` once lost 86 knowledge rows; the drill uses `VACUUM INTO`.

## 6. The mirror is populated from outside (D-63)

Nothing outside the deployment directory is mounted into the container — not a
checkout, not a key, not an agent socket. `make mirror` runs on the host, as the
operator, and clones or fetches every registered repo into `data/repos/<id>/bare.git`,
which lore already reads.

This is what lets the service hold no git credentials at all. The cost is that a
person has to run it, so a mirror older than `MAX_MIRROR_AGE_MS` is refused with the
command that fixes it, rather than reviewed as though it were current.
