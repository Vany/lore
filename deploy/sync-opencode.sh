#!/usr/bin/env bash
#
# Stage the host's opencode configuration for the containers.
#
# RUN THIS ON THE DEPLOYMENT HOST. The template is the real opencode installation
# in the operator's home — the one they curate interactively, authenticate with
# `opencode auth login`, and add plugins and agents to. Containers get a derived,
# sanitised copy of it rather than a second configuration that would drift.
#
# Reviewers must inherit everything a Claude Code session has — the plane MCP
# server, the plugins, the read-only agent (D-12). A reviewer with less context
# than the author is not a peer. Copying the working configuration is the honest
# way to get that; re-deriving it by hand would drift.
#
# But NOT wholesale. Three things are removed on the way, and the first is the one
# that matters:
#
#   * THE ANTHROPIC CREDENTIAL. Claude writes the code under review, so every
#     reviewer tier is non-Anthropic (D-1). Today that is enforced by tier config —
#     one wrong model id and the author's own model family grades its own work,
#     silently. With no Anthropic credential in the container it is enforced by
#     ABSENCE, which no typo can undo.
#   * the claude-auth plugin, which exists to supply exactly that credential.
#   * the `server` block, because the container passes its own flags and mDNS on a
#     loopback interface only produces warnings.
#
# Whether the surviving credentials actually cover the configured ladder is not
# this script's business — `lore doctor` answers that against a live catalogue,
# which is the only place the question can be answered honestly.
#
# Usage, on the deployment host:
#   ./sync-opencode.sh ./opencode      # or just: make up

set -euo pipefail

STAGE="${1:?usage: sync-opencode.sh <staging-dir>}"
SRC_CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
SRC_AUTH="${OPENCODE_DATA_DIR:-$HOME/.local/share/opencode}/auth.json"

command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
[ -d "$SRC_CONFIG" ] || { echo "no opencode config at $SRC_CONFIG"; exit 1; }
[ -f "$SRC_AUTH" ] || { echo "no opencode auth at $SRC_AUTH — run 'opencode auth login' first"; exit 1; }

mkdir -p "$STAGE/config" "$STAGE/data"
# 0755, not 0700.
#
# These directories are bind-mounted into a container running under a DIFFERENT
# uid, which needs execute permission to traverse them. At 0700 opencode cannot
# even list agents/ — and the failure is an instant HTTP 500 on agent lookup, which
# looks nothing like a permission problem from the caller's side.
#
# Host protection comes from where this directory lives, not from these bits.
chmod 755 "$STAGE" "$STAGE/config" "$STAGE/data"

python3 - "$SRC_CONFIG" "$SRC_AUTH" "$STAGE" <<'PY'
import json, os, shutil, sys

src_config, src_auth, stage = sys.argv[1], sys.argv[2], sys.argv[3]

# Any provider whose models would violate D-1. Removed rather than merely unused:
# a credential that is not present cannot be reached by a misconfiguration.
FORBIDDEN_PROVIDERS = {"anthropic"}
FORBIDDEN_PLUGINS = ("opencode-claude-auth",)

# ---- auth ----------------------------------------------------------------
auth = json.load(open(src_auth))
kept = {k: v for k, v in auth.items() if k not in FORBIDDEN_PROVIDERS}
dropped = sorted(set(auth) - set(kept))

if not kept:
    sys.exit("refusing: every credential was forbidden — the container would have no provider at all")

out_auth = os.path.join(stage, "data", "auth.json")
with open(out_auth, "w") as f:
    json.dump(kept, f, indent=2)
# Back to 0600, and READ-WRITE for the owner on purpose.
#
# This was 0644 because the container ran as a different uid and could not otherwise
# read it. The container now runs as the uid that owns this file, so the widening is
# no longer needed — and an OAuth credential must be WRITABLE anyway: opencode
# renews the token roughly hourly by rewriting this file.
#
# The blanket chmod sweep further down would flatten this back to 0644, so the final
# mode is set after it, not here.
os.chmod(out_auth, 0o600)

# ---- config --------------------------------------------------------------
cfg_path = os.path.join(src_config, "opencode.json")
cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}

plugins = [p for p in cfg.get("plugin", []) if not any(p.startswith(f) for f in FORBIDDEN_PLUGINS)]
removed_plugins = [p for p in cfg.get("plugin", []) if p not in plugins]
if plugins:
    cfg["plugin"] = plugins
else:
    cfg.pop("plugin", None)

# The container supplies its own hostname/port, and mDNS on loopback only warns.
cfg.pop("server", None)

with open(os.path.join(stage, "config", "opencode.json"), "w") as f:
    json.dump(cfg, f, indent=2)

# Everything else in the config directory travels as-is: agent definitions, the
# oh-my-openagent map, any local plugin state.
for name in os.listdir(src_config):
    # Backups and package metadata are the operator's working files, not
    # configuration the container needs. Copying `.bak` files in particular risks
    # someone later "fixing" the container by editing the wrong one.
    if name in {"opencode.json", "node_modules", ".gitignore", "package.json", "package-lock.json"}:
        continue
    if ".bak" in name:
        continue
    s, d = os.path.join(src_config, name), os.path.join(stage, "config", name)
    (shutil.copytree if os.path.isdir(s) else shutil.copy2)(s, d, **({"dirs_exist_ok": True} if os.path.isdir(s) else {}))

# ---- report --------------------------------------------------------------
print(f"  providers kept   : {', '.join(sorted(kept))}")
print(f"  providers dropped: {', '.join(dropped) if dropped else '(none)'}")
print(f"  plugins removed  : {', '.join(removed_plugins) if removed_plugins else '(none)'}")
print(f"  mcp servers      : {', '.join((cfg.get('mcp') or {}).keys()) or '(none)'}")
PY

# Everything staged must be readable inside the container. Checking here beats
# discovering it as a 500 with no diagnostic later.
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +

# ...except the credential, which this sweep would otherwise widen to 0644.
#
# It is last so nothing can flatten it afterwards, and it is 0600 rather than 0400
# because an OAuth token is renewed IN PLACE: opencode rewrites this file when the
# access token expires, roughly hourly. Read-only here would work for one hour and
# then fail looking like a cancelled subscription.
chmod 600 "$STAGE/data/auth.json"

# INV-8, ENFORCED. This used to be two warnings and a shrug, which is how a
# reviewer nearly ran write-capable.
#
# Observed on the deployment host, not theorised: with the agent file unreadable, a
# prompt NAMING it fails outright — but a prompt without an agent silently runs as
# `build`, the WRITE-CAPABLE default. So the failure mode is not "reviews stop", it
# is "reviews continue, with write tools, and nothing says so".
#
# The per-request tool denial is the belt and it did hold. This is the braces, and
# braces that only print a message are decoration. Refusing to stage is the whole
# point: a container that cannot start is loud, and INV-9 says reviewers are
# read-only ALWAYS.
if [ ! -r "$STAGE/config/agents/readonly.md" ]; then
  echo "REFUSING: agents/readonly.md is missing or unreadable at $STAGE/config/agents/." >&2
  echo "          opencode falls back to the WRITE-CAPABLE 'build' agent when --agent" >&2
  echo "          names something it cannot read, and says nothing about it (INV-8)." >&2
  echo "          Create it in $SRC_CONFIG/agents/ and re-run." >&2
  exit 1
fi

# D-71, ENFORCED THE SAME WAY, because the removal was incomplete for a day.
#
# lore READS a test suite and never runs one. `src/reviewer/prompts.ts` was updated
# when that was decided; the AGENT FILE was not — it said "explores, runs tests" in
# its description and "You explore the codebase, run tests" in its body, while
# carrying `bash: true`. So every reviewer since was instructed to do the one thing
# D-71 removed, with the tool to do it.
#
# It survived because of where it lives. Reviewers inherit the OPERATOR's opencode
# configuration (D-12, D-47), so this file sits outside the repository: lore's own
# ladder never reviews it, no test covers it, and a behaviour change here cannot
# reach it. This check is the only thing that can.
#
# Matched on the INSTRUCTION, not on the word "test" — reading tests is the point and
# the prompt should keep saying so.
#
# And negated lines are dropped before matching, because a prompt that says "do not
# run the suite" is the fixed state, not the broken one. Written the naive way first,
# it refused the very file that corrects the problem — which is `polarity()`'s bug
# from session 32 (negation cancelled across a whole statement) reappearing in a build
# gate. Per line, like the fix there.
# PER CLAUSE, not per line — and this took two wrong attempts, both instructive.
#
# Matching the whole line refused the corrected file, whose whole point is the
# sentence "do not run the project's test suite". Then dropping any line carrying a
# negation let the ORIGINAL through, because `explores, runs tests, never edits files`
# has "never" in a clause about editing. Negation binds to its own clause, exactly as
# `knowledge/conflict.ts` had to learn when a compound ADR sentence came out as its
# own opposite and stopped a real review.
# Flattened before splitting, because the instruction wraps. The original said
#
#     You explore the codebase, run
#     tests, and look up context
#
# with "run" ending one line and "tests" starting the next, so anything working line
# by line cannot see it — and that is the exact file this check exists for.
#
# `tolower()` rather than IGNORECASE: that is a gawk extension and this host's awk
# silently ignores it, which let "Do not run the project's test suite" through as an
# offence on the first attempt. A flag that is quietly not supported is the same class
# of defect as everything else here.
OFFENDING=$(tr '\n' ' ' < "$STAGE/config/agents/readonly.md" | awk '
  {
    n = split($0, parts, /[,;:.]| — /)
    for (i = 1; i <= n; i++) {
      c = tolower(parts[i])
      if (c ~ /(run|runs|running|execute|executes) (the )?(project.?s |target.?s |full )?(test|tests|suite)/ &&
          c !~ /(do not|don.t|never|without|instead|rather than|not yours|out of bounds|not to)/) {
        gsub(/^[ \t]+|[ \t]+$/, "", parts[i])
        printf "  offending clause: %s\n", parts[i]
      }
    }
  }')
if [ -n "$OFFENDING" ]; then
  printf '%s\n' "$OFFENDING" >&2
  echo "REFUSING: agents/readonly.md instructs the reviewer to RUN tests (lines above)." >&2
  echo "          lore reads a suite and never runs one (D-71). The reviewer container" >&2
  echo "          has bash and a checkout, so this is an instruction it can carry out —" >&2
  echo "          executing an arbitrary dependency tree on the review host to" >&2
  echo "          rediscover a fact the repository's own CI already reports." >&2
  echo "          Fix $SRC_CONFIG/agents/readonly.md and re-run." >&2
  exit 1
fi

# Last line of defence: prove the staged credentials really are clean.
if grep -qi '"anthropic"' "$STAGE/data/auth.json"; then
  echo "REFUSING: an Anthropic credential survived into the staged auth.json" >&2
  exit 1
fi

echo "  staged at        : $STAGE"
