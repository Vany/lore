#!/usr/bin/env bash
#
# Hand a credential re-logged on this host to the running deployment, and make lore
# stop refusing the routes it parked on the old one.  `make sync-creds`.
#
# Run AFTER `opencode auth login` on the deployment host. Four steps, each of which has
# a silent way to go wrong that this script turns into a loud one:
#
#   1. REFUSE TO GO BACKWARDS. opencode inside the container renews OAuth tokens by
#      rewriting the staged auth.json, roughly hourly. Once it has, the HOST copy holds an
#      older token than the container's — and with refresh-token rotation, possibly a dead
#      one. Copying host over stage then would kill a working credential while looking
#      exactly like a renewal. So an OAuth entry that expires LATER in the stage than on
#      the host stops the sync. FORCE=1 overrides.
#   2. STAGE through sync-opencode.sh, never a second copy of it: that script is the one
#      definition of what a container may hold (no Anthropic credential, D-1). It restages
#      the config directory too — the same thing `make up` does.
#   3. CHECK THE CONTAINER SEES IT. auth.json is a single-file bind mount, which follows
#      the INODE: if anything ever replaced the file by rename, the container keeps reading
#      the old one and every check on the host side would pass.
#   4. UNPARK only the routes of providers whose credential actually changed — a route
#      parked on a spent quota elsewhere stays parked. Nothing changed at all is an error:
#      the operator meant to renew something, and a login that did not reach this host's
#      auth.json (another machine, another OPENCODE_DATA_DIR) must not read as done.
#
# opencode is NOT restarted, so no review in flight is killed. Unverified assumption,
# stated so it can be checked: opencode re-reads auth.json per request rather than
# caching it from startup. If a route still refuses with "credentials" after this, run
# `docker compose restart opencode` (when the board is quiet) and say so in MEMO.md.
#
# Usage, from the deployment directory:   make sync-creds [FORCE=1]

set -euo pipefail

COMPOSE="${COMPOSE:-docker compose}"
STAGE=./opencode
STAGED="$STAGE/data/auth.json"
SRC_AUTH="${OPENCODE_DATA_DIR:-$HOME/.local/share/opencode}/auth.json"
IN_CONTAINER=/home/lore/.local/share/opencode/auth.json

[ -f "$SRC_AUTH" ] || { echo "no opencode auth at $SRC_AUTH — run 'opencode auth login' first"; exit 1; }
[ -f "$STAGED" ] || { echo "nothing staged at $STAGED — this deployment was never brought up; run 'make up'"; exit 1; }

before=$(mktemp)
trap 'rm -f "$before"' EXIT
cp "$STAGED" "$before"

# ---- 1. refuse to go backwards ----------------------------------------------
python3 - "$SRC_AUTH" "$STAGED" "${FORCE:-}" <<'PY'
import json, sys, time
host, stage, force = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3]
when = lambda ms: time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(ms / 1000))
behind = [
    (p, s["expires"], host[p].get("expires", 0))
    for p, s in stage.items()
    if s.get("type") == "oauth" and p in host and s.get("expires", 0) > host[p].get("expires", 0)
]
for p, s, h in behind:
    print(f"{p}: the container renewed this token itself (expires {when(s)}); the host's is older ({when(h)}).")
if behind and not force:
    print("REFUSING: syncing would replace a working token with an older, possibly revoked one.")
    print("  Re-run 'opencode auth login' for it on this host first, or override with: make sync-creds FORCE=1")
    sys.exit(1)
PY

# ---- 2. stage --------------------------------------------------------------
./sync-opencode.sh "$STAGE" >/dev/null

# Which providers changed, by comparing the staged copy before and after: the staging
# script has already dropped what a container may not hold, so this sees only what lands.
changed=$(python3 - "$before" "$STAGED" <<'PY'
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
print(" ".join(sorted(p for p in set(a) | set(b) if a.get(p) != b.get(p))))
PY
)
if [ -z "$changed" ]; then
  echo "NOTHING CHANGED: $SRC_AUTH already matches what the container holds."
  echo "  Did 'opencode auth login' run on THIS host, as this user? Nothing was unparked."
  exit 1
fi
echo "credentials changed: $changed"

# ---- 3. the container must read what was staged -----------------------------
want=$(shasum -a 256 < "$STAGED" | cut -d' ' -f1)
got=$($COMPOSE exec -T opencode sha256sum "$IN_CONTAINER" | cut -d' ' -f1) \
  || { echo "could not read auth.json inside the opencode container — is it up?"; exit 1; }
if [ "$want" != "$got" ]; then
  echo "THE CONTAINER DOES NOT SEE THE NEW CREDENTIALS: its auth.json differs from the staged one."
  echo "  The bind mount has detached from the file. 'docker compose up -d opencode' re-binds it."
  exit 1
fi
echo "opencode sees the new auth.json."

# ---- 4. unpark the changed providers' routes --------------------------------
# A route id is `<provider>/<model>`, so `<provider>/` matches exactly that provider's
# routes and not `openrouter/openai/...`, which is a different credential. Checked
# against the listing first because `unpark --route` exits non-zero when nothing
# matches — correct for a typo, wrong here, where nothing parked is the good case.
listing=$($COMPOSE exec -T lore node /app/src/index.ts unpark)
for p in $changed; do
  if printf '%s\n' "$listing" | grep -q "^route $p/"; then
    $COMPOSE exec -T lore node /app/src/index.ts unpark --route "$p/"
  else
    echo "$p: no parked routes — nothing to clear."
  fi
done
