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
DB="$DATA/lore.db"
INTERVAL=${LORE_MIRROR_INTERVAL:-300}

# Long enough that a fetch never blocks the next pass for ever; short enough that a
# hung remote is visible within one interval.
FETCH_TIMEOUT=${LORE_MIRROR_TIMEOUT:-240}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

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

one_pass() {
  if [ ! -f "$DB" ]; then
    log "no registry at $DB — nothing to refresh (is LORE_HOST_DATA right?)"
    return 99
  fi

  # Read-only in both readers: this must never be the thing that corrupts the
  # registry, and it has no business writing to it anyway.
  #
  # `sqlite3` first because it lives at /usr/bin on macOS — a path every supervisor
  # already has — while node is wherever a package manager put it. node is the
  # fallback for a host with no sqlite3 CLI. If neither is present that is a fact
  # worth stating, not a reason to report an empty repository list, which would look
  # exactly like "nothing needs fetching".
  if command -v sqlite3 >/dev/null 2>&1; then
    repos=$(sqlite3 -readonly -noheader -separator "$(printf '\t')" "$DB" \
      "SELECT id, name, git_url FROM repo" 2>&1) \
      || { log "could not read $DB with sqlite3: $repos"; return 99; }
  elif command -v node >/dev/null 2>&1; then
    repos=$(node -e '
      const { DatabaseSync } = require("node:sqlite");
      const d = new DatabaseSync(process.argv[1], { readOnly: true });
      for (const r of d.prepare("SELECT id, name, git_url FROM repo").all()) {
        console.log([r.id, r.name, r.git_url].join("\t"));
      }
    ' "$DB" 2>&1) || { log "could not read $DB with node: $repos"; return 99; }
  else
    log "neither sqlite3 nor node is on PATH ($PATH) — cannot read the registry. apt install sqlite3"
    return 99
  fi

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
      if err=$( { $LIMIT git clone --bare -- "$url" "$bare" \
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
  done < "$list"

  rm -f "$list"
  return "$failed"
}

if [ "${1:-}" = "--loop" ]; then
  log "mirror refresh: every ${INTERVAL}s, data $DATA"
  while :; do
    one_pass
    sleep "$INTERVAL"
  done
else
  one_pass
fi
