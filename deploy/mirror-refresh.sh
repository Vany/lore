#!/bin/sh
# Keep every registered mirror fresh, on the host, as the operator.
#
# **Why this is a host process and not something lore does.** lore runs in a
# container that holds the knowledge base, the signing key and every provider
# credential; the host already authenticates to the forge as a person who is allowed
# to read these repositories. Moving the fetch inside would mean issuing lore its own
# credential for something the host can already do — more machinery, another secret,
# and on a repository the operator does not own, a deploy key they cannot authorize.
#
# **Why it is a process and not a person.** The client cannot do it: it is an agent,
# usually on another machine, with no shell here. And a human who has to remember is
# a human who forgets — on 2026-08-05 a forgotten refresh caused more review failures
# than every model and transport fault combined, ending with a review refused against
# a mirror 192 minutes old. Refreshing the mirror is the service's responsibility;
# this is where that responsibility is discharged.
#
# **No docker.** The repository list is read straight out of the SQLite registry,
# read-only, so this keeps working while the container is down, restarting, or being
# rebuilt — which is exactly when a stale mirror would otherwise go unnoticed.
#
# Every repository is refreshed, and that is not the behaviour `make mirror REPO=`
# refuses. That refusal is about an interactive command reaching remotes nobody named
# because one was asked for. Here, keeping all registered mirrors current IS what was
# asked for, once, when the daemon was installed.
#
#   ./mirror-refresh.sh          one pass, then exit (what the timer runs)
#   ./mirror-refresh.sh --loop   stay resident, every LORE_MIRROR_INTERVAL seconds
#
# Exit status is the number of repositories that FAILED, so a supervisor can see it.

set -u

cd "$(dirname "$0")" || exit 99

# A SUPERVISOR'S ENVIRONMENT IS NOT A SHELL'S.
#
# launchd hands a job a minimal PATH with none of the places a package manager puts
# things, and this failed on its first scheduled run with "node: command not found"
# while working perfectly by hand. systemd --user is the same story. Naming the
# directories here is uglier than inheriting a login shell's PATH and survives being
# started by something that never sourced a profile.
PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH

DATA=$(grep -E '^LORE_HOST_DATA=' .env 2>/dev/null | cut -d= -f2)
DATA=${DATA:-/var/lib/lore}
# The MIRRORS stay under $DATA on the host bind — the T0 sandbox binds worktree paths
# into sibling containers by host-resolved absolute path, so they cannot move.
# The REGISTRY moved into a volume on 2026-08-08 (spec/deployment.md 4.1). Both are read
# below, host path first, so an unmigrated deployment keeps working unchanged.
DB="$DATA/lore.db"
PROJECT=${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}
DBVOL="${PROJECT}_lore-db"
INTERVAL=${LORE_MIRROR_INTERVAL:-300}

# Long enough that a fetch never blocks the next pass for ever; short enough that a
# hung remote is visible within one interval.
FETCH_TIMEOUT=${LORE_MIRROR_TIMEOUT:-240}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# GNU FORM FIRST, and the order is the whole point — it is NOT interchangeable.
#
# `stat -f %m` is BSD for "modification time". On GNU coreutils `-f` means
# `--file-system` and `%m` there is the MOUNT POINT — so the BSD spelling does not fail
# on Linux, it SUCCEEDS and returns something like `/`. Both calls below then return the
# same string on every pass, the equality test always passes, and a request renewed
# mid-fetch is deleted anyway: silently the exact race the renewal protocol exists to
# close, on every non-macOS host. (An earlier version of this fix put BSD first on the
# theory that the GNU call would fail; it does not, which is worse than the bug it was
# fixing — a wrong answer instead of a missing one.)
#
# `stat -c %Y` is GNU for mtime and is not accepted by BSD stat at all, so it fails
# cleanly on macOS and falls through. One order works on both; the other is wrong on one.
#
# THE FALLBACK IS A PARAMETER, kept asymmetric between the two call sites below exactly
# as it was: if stat itself is unavailable in BOTH forms — genuinely pathological, and
# worse than anything this fix is for — req_mtime and now_mtime must still come out
# UNEQUAL, so the safe branch (leave the request for the next pass) fires rather than
# the delete. Losing that would trade one silent-wrong-default failure for another.
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo "$2"; }

# `timeout` is GNU coreutils and is NOT on macOS, where this first ran and reported
# every repository as failing with "timeout: command not found" — a wrapper turning a
# working fetch into a fake failure. Homebrew's coreutils installs it as `gtimeout`.
# Where neither exists the fetch runs unwrapped, and the ssh options below are what
# stop it hanging: a connect timeout for an unreachable host, and BatchMode so a
# background job with no terminal can never sit at a passphrase prompt for ever.
if command -v timeout >/dev/null 2>&1; then LIMIT="timeout $FETCH_TIMEOUT"
elif command -v gtimeout >/dev/null 2>&1; then LIMIT="gtimeout $FETCH_TIMEOUT"
else LIMIT=""
fi

# Not IdentitiesOnly: this is the OPERATOR's ssh, and it should use whatever their
# config says — agent, keychain, per-host IdentityFile. On this host the key carries a
# passphrase and the macOS keychain supplies it, which is why a LaunchAgent running in
# the user's session can fetch and a system-wide daemon could not.
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=20}"

# The repository list, from wherever the registry actually is.
#
# THE HOST PATH FIRST, and the volume second, because that order is what makes an
# unmigrated deployment behave exactly as it did. A migrated one has no host file at all.
#
# **This is the one place docker is needed**, and it was worth avoiding: the header above
# says this must keep working while the container is down, restarting or being rebuilt —
# which is exactly when a stale mirror goes unnoticed. A throwaway `docker run` still
# satisfies that; it needs the daemon, not the service. It fails only when docker itself
# is down, and then the service is down too and a stale mirror is not the problem.
#
# It cost seventeen hours of stale mirrors to learn this file existed: the database moved
# into a volume and this went on reading the host path, logging "no registry" every five
# minutes into a file nobody reads, until a customer's review was refused for a mirror
# 1026 minutes old.
read_registry() {
  if [ -f "$DB" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 -readonly -noheader -separator "$(printf '\t')" "$DB" "SELECT id, name, git_url FROM repo" 2>&1
      return $?
    fi
    if command -v node >/dev/null 2>&1; then
      node -e '
        const { DatabaseSync } = require("node:sqlite");
        const d = new DatabaseSync(process.argv[1], { readOnly: true });
        for (const r of d.prepare("SELECT id, name, git_url FROM repo").all()) {
          console.log([r.id, r.name, r.git_url].join("\t"));
        }
      ' "$DB" 2>&1
      return $?
    fi
    log "neither sqlite3 nor node is on PATH ($PATH) — cannot read $DB. apt install sqlite3"
    return 99
  fi

  if command -v docker >/dev/null 2>&1 && docker volume inspect "$DBVOL" >/dev/null 2>&1; then
    docker run --rm -v "$DBVOL":/db --entrypoint node "${PROJECT}-lore:latest" -e '
      const { DatabaseSync } = require("node:sqlite");
      const d = new DatabaseSync("/db/lore.db", { readOnly: true });
      for (const r of d.prepare("SELECT id, name, git_url FROM repo").all()) {
        console.log([r.id, r.name, r.git_url].join("\t"));
      }
    ' 2>&1 | tr -d '\r'
    return $?
  fi

  log "no registry: no $DB, and no readable $DBVOL volume (is LORE_HOST_DATA right, and has docker started?)"
  return 99
}

one_pass() {

  # Read-only in every reader: this must never be the thing that corrupts the registry,
  # and it has no business writing to it anyway.
  repos=$(read_registry) || { log "could not read the registry: $repos"; return 99; }

  [ -z "$repos" ] && { log "no repositories registered yet"; return 0; }

  # A temp file rather than a pipe into `while`. Piped, the loop runs in a SUBSHELL,
  # so every increment of `failed` is discarded and this returned 0 while both
  # repositories were failing — a refresher reporting success for work it did not do,
  # which is the one thing this whole project exists to refuse. Caught on the first run.
  list=$(mktemp) || return 99
  printf '%s\n' "$repos" > "$list"

  failed=0
  while IFS="$(printf '\t')" read -r id name url; do
    [ -z "$id" ] && continue
    bare="$DATA/repos/$id/bare.git"

    if [ -d "$bare/objects" ]; then
      if err=$(cd "$bare" && $LIMIT git fetch --prune --tags origin 2>&1); then
        log "fetched  $name"
      else
        log "FAILED   $name ($url): $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-160)"
        failed=$((failed + 1))
      fi
    else
      mkdir -p "$(dirname "$bare")"
      # Two steps, deliberately: `clone --bare` populates refs/heads/* and NOT
      # refs/remotes/origin/*, so a clone alone leaves the mirror in the state where
      # `origin/<branch>` does not resolve and a review silently takes the frozen
      # local branch instead. The refspec and the fetch are what finish the job.
      #
      # `{ beat; true; }` BETWEEN THEM — found by lore's own review of the per-repo
      # `beat` fix just above: THIS branch alone runs two $LIMIT-bounded commands
      # sequentially, clone then fetch, each up to FETCH_TIMEOUT — so a first clone
      # landing near the limit followed by its fetch could still leave a gap up to
      # 2×FETCH_TIMEOUT before reaching the per-repo `beat` after this whole block,
      # exceeding HEARTBEAT_STALE_MS even after that fix. `true` keeps a hiccup writing
      # the heartbeat file from being read as "the clone failed" by the `if` below.
      if err=$( { $LIMIT git clone --bare -- "$url" "$bare" \
            && { beat; true; } \
            && git -C "$bare" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' \
            && $LIMIT git -C "$bare" fetch --prune --tags origin; } 2>&1); then
        log "cloned   $name"
      else
        # A half-made clone is worse than none: it satisfies the "is this a repo?"
        # check next time, so nothing ever tries to clone it properly again.
        rm -rf "$bare"
        log "FAILED   $name ($url): $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-160)"
        failed=$((failed + 1))
      fi
    fi
    # AFTER EVERY REPO, NOT ONLY BETWEEN PASSES — found by lore's own review of
    # src/git (mirror-request.ts's HEARTBEAT_STALE_MS is the reader on the other
    # side). The main loop's own `beat` between `one_pass` and `serve_requests` bounds
    # the gap by the WHOLE pass's length, which is every registered repo's
    # $FETCH_TIMEOUT summed — already past HEARTBEAT_STALE_MS with two repos, and
    # growing without bound as more are registered. Beating per repo instead bounds
    # the real gap at ONE repo's fetch, however many are registered.
    beat
  done < "$list"

  rm -f "$list"
  return "$failed"
}

# ON DEMAND, NOT ONLY ON A TIMER (D-100).
#
# lore cannot fetch — no key, no agent, and deliberately no business having either — so
# when a review names a branch the mirror does not have, it asks HERE and waits. The
# channel is the shared data directory, bind-mounted at the same absolute path on both
# sides: the only thing the container and this host already agree on. No port, no secret.
#
# THE REQUEST IS ANSWERED BY DELETING IT. That is the entire protocol, and it is the
# deletion rather than a status file because a deletion cannot be half-written.
#
# THE HEARTBEAT IS WHY A DEAD LOOP IS NOT A SLOW ONE. Without it a request nobody consumes
# looks exactly like a fetch in progress, and lore would wait its whole timeout for a
# daemon that is not running. Stamped every pass; lore refuses immediately when it is
# stale, and says to reinstall this.
REQUEST="$DATA/mirror-request"
HEARTBEAT="$DATA/mirror-heartbeat"

beat() { mkdir -p "$DATA" 2>/dev/null; : > "$HEARTBEAT"; }

# What the loop does between full passes: answer requests promptly, and prove it is alive.
#
# The request is deleted AFTER the fetch, never before: deleting first would tell lore the
# mirror was current while the fetch was still running, and it would then report a branch
# missing that was seconds from arriving — the precise failure this exists to end.
serve_requests() {
  waited=0
  while [ "$waited" -lt "$INTERVAL" ]; do
    if [ -f "$REQUEST" ]; then
      # THE REQUEST OUTLIVES THE FETCH, and is deleted only if nobody renewed it.
      #
      # Two races meet here, and each earlier protocol closed one by opening the other.
      # Delete-after with one shared filename acknowledged requests that arrived DURING
      # the fetch — a review whose repository was read before its push landed. The
      # rename-aside that fixed it (raised by lore's own t2) made the request vanish at
      # PICKUP, and lore reads the deletion as "a real fetch answered me" — so it
      # re-resolved branches mid-fetch and failed two freshly pushed reviews in one
      # night with "not a timing problem", which was exactly a timing problem.
      #
      # So: copy aside for the record, fetch, then delete the request ONLY IF its mtime
      # is unchanged — a request renewed mid-fetch survives to get its own pass. The
      # original file stays put for the whole fetch, so a waiter that watches either
      # the request or its .serving twin sees completion, never pickup. Compatible with
      # both sides deployed today and both sides after D-107's fix.
      cp -f "$REQUEST" "$REQUEST.serving" 2>/dev/null || true
      req_mtime="$(mtime "$REQUEST" 0)"
      log "refresh requested by lore"
      one_pass
      now_mtime="$(mtime "$REQUEST" -1)"
      if [ "$req_mtime" = "$now_mtime" ]; then
        rm -f "$REQUEST"
      else
        log "request renewed mid-fetch — left for the next pass"
      fi
      rm -f "$REQUEST.serving"
    fi
    beat
    sleep "$POLL"
    waited=$((waited + POLL))
  done
}

# Short enough that a client pushing and immediately asking for a review does not notice,
# long enough that this is not a busy loop. The cost of a tick is one `test -f`.
POLL=${LORE_MIRROR_POLL:-2}

if [ "${1:-}" = "--loop" ]; then
  log "mirror refresh: full pass every ${INTERVAL}s, on-demand within ${POLL}s, data $DATA"
  while :; do
    one_pass
    beat
    serve_requests
  done
elif [ "${1:-}" = "--once-and-serve" ]; then
  # For a supervisor that restarts on exit rather than one that keeps a process alive.
  one_pass
  beat
  serve_requests
else
  one_pass
  beat
fi
