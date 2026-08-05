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

**The split (D-59).** Litestream writes a continuously-restorable **local** file
replica beside the deployment; an outer script carries it off the machine. The
boundary is deliberate: lore owns the half it can be responsible for without holding
any credential, and a container with no S3 key cannot leak one. Always on — no
profile, no credentials, nothing to forget to enable.

A copy on the same disk is **not a backup**. It survives a corrupted database, a bad
bulk write and a wrong `down-hard`; it does not survive the disk. `make backup-check`
reports the local half only, and says so.

**Restore is tested, not assumed.** `make backup-drill` restores from a copy with the
source destroyed first, and `make status` warns when the replica has not been written
in an hour. The drill uses `VACUUM INTO`: a WAL database copied with `cp` loses
whatever is still in the write-ahead log.

## 6. The mirror is refreshed by a host process (D-65)

Nothing outside the deployment directory is mounted into the container — not a
checkout, not a key, not an agent socket. `deploy/mirror-refresh.sh` runs on the HOST,
as the operator, and clones or fetches every registered repo into
`data/repos/<id>/bare.git`, which lore already reads.

    make mirror-daemon        every five minutes, launchd or systemd --user
    make mirror-daemon-log    what it last did
    make mirror REPO=<name>   one repository, by hand

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
