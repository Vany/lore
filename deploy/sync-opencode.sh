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
# But NOT wholesale. Two things are removed on the way:
#
#   * the claude-auth plugin, which exists to supply an Anthropic credential. Claude
#     writes the code under review, so no reviewer may reach an Anthropic model (D-1).
#     The credential itself is kept out by `lore creds-sync` (`make sync-creds`), whose
#     FORBIDDEN_INTEGRATIONS lists the same provider — change both or neither.
#   * the `server` block, because the container passes its own flags and mDNS on a
#     loopback interface only produces warnings.
#
# CREDENTIALS ARE NOT STAGED HERE ANY MORE. opencode 2.x keeps them in its database and
# reads auth.json only once, when that database is created, so a staged file looked
# like the credential path while carrying nothing after first boot. They travel through
# opencode's API instead: `make sync-creds`.
#
# Whether the credentials actually cover the configured ladder is not this script's
# business — `lore doctor` answers that against a live catalogue, which is the only
# place the question can be answered honestly.
#
# Usage, on the deployment host:
#   ./sync-opencode.sh ./opencode      # or just: make up

set -euo pipefail

STAGE="${1:?usage: sync-opencode.sh <staging-dir>}"
SRC_CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
[ -d "$SRC_CONFIG" ] || { echo "no opencode config at $SRC_CONFIG"; exit 1; }

mkdir -p "$STAGE/config"
# 0755, not 0700.
#
# These directories are bind-mounted into a container running under a DIFFERENT
# uid, which needs execute permission to traverse them. At 0700 opencode cannot
# even list agents/ — and the failure is an instant HTTP 500 on agent lookup, which
# looks nothing like a permission problem from the caller's side.
#
# Host protection comes from where this directory lives, not from these bits.
chmod 755 "$STAGE" "$STAGE/config"

python3 - "$SRC_CONFIG" "$STAGE" <<'PY'
import json, os, shutil, sys

src_config, stage = sys.argv[1], sys.argv[2]

FORBIDDEN_PLUGINS = ("opencode-claude-auth",)

# A credential staged by the 1.x version of this script. 2.x never reads it again, and
# leaving a copy of every provider key in the deploy directory buys nothing but a leak.
stale_auth = os.path.join(stage, "data", "auth.json")
if os.path.exists(stale_auth):
    os.remove(stale_auth)
    print("  removed the 1.x staged auth.json — credentials now go through `make sync-creds`")
# And any host secret an earlier run copied into the config: the copy loop below adds
# files, it never deletes, so a skip-list alone would leave an old copy in place for ever.
# It did — the host service's password sat in a live container's config for a day.
for secret in ("service.json", "auth.json", "mcp-auth.json"):
    stale = os.path.join(stage, "config", secret)
    if os.path.exists(stale):
        os.remove(stale)
        print(f"  removed a staged host secret: config/{secret}")

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

# THE SECOND CHATGPT SUBSCRIPTION'S PROVIDER (D-157), defined HERE rather than left to the
# operator's opencode.json: `make login-openai2` and `openai2-creds.py` only ever deliver
# its credential, and a credential for a provider the config never defines is a fallback
# that silently does not exist — the ladder skips past it to the next route. Staged only
# when an account #2 login exists, so a deployment without one is not shown a provider it
# cannot use; and it replaces any host definition, so there is exactly one.
# The token alone selects and bills the account: no `chatgpt-account-id` header is needed.
# Limits are the OpenAI plugin's own for its ChatGPT models (400k window, 272k input).
openai2_state = os.environ.get("OPENAI2_STATE") or os.path.expanduser("~/.config/lore/openai2.json")
if os.path.exists(openai2_state):
    cfg.setdefault("provider", {})["openai2"] = {
        "npm": "@ai-sdk/openai",
        "name": "OpenAI ChatGPT (second subscription)",
        "options": {"baseURL": "https://chatgpt.com/backend-api/codex", "headers": {"originator": "opencode"}},
        "models": {"gpt-5.6-sol": {"name": "GPT-5.6 Sol", "limit": {"context": 400000, "input": 272000, "output": 128000}}},
    }

# RECONCILED, NOT OVERLAID. The copy below only ever added, so an agent, command or plugin
# file the operator deleted on the host lived on in the container and kept shaping
# reviews — and a stale `agents/readonly.md` could even satisfy the INV-8 guard further
# down after the host's copy was gone. So everything staged before is cleared first.
#
# THE DIRECTORY ITSELF STAYS, emptied in place: it is bind-mounted into a running
# container, and a directory removed and recreated is a new inode the container never
# sees. Kept: what opencode itself installs here (`node_modules` and the package files
# its plugin install writes) — clearing them would only force a reinstall on every `up`.
# lore-ok[b9425e16]: reconciled here — the staged config is emptied in place before copying.
OPENCODE_OWNED = {"node_modules", "package.json", "package-lock.json"}
staged_config = os.path.join(stage, "config")
for name in os.listdir(staged_config):
    if name in OPENCODE_OWNED:
        continue
    path = os.path.join(staged_config, name)
    shutil.rmtree(path) if os.path.isdir(path) and not os.path.islink(path) else os.remove(path)

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
    # THE HOST'S OWN SECRETS STAY ON THE HOST. 2.x writes `service.json` here — the
    # password of the operator's background opencode service — and a blanket copy put it
    # in the container's config, readable by every reviewer's shell. Nothing in the
    # container needs it: the container's server takes OPENCODE_SERVER_PASSWORD.
    if name in {"service.json", "auth.json", "mcp-auth.json"}:
        continue
    if ".bak" in name:
        continue
    s, d = os.path.join(src_config, name), os.path.join(stage, "config", name)
    (shutil.copytree if os.path.isdir(s) else shutil.copy2)(s, d, **({"dirs_exist_ok": True} if os.path.isdir(s) else {}))

# ---- report --------------------------------------------------------------
print(f"  plugins removed  : {', '.join(removed_plugins) if removed_plugins else '(none)'}")
print(f"  mcp servers      : {', '.join((cfg.get('mcp') or {}).keys()) or '(none)'}")
print(f"  openai2 provider : {'staged (D-157)' if 'openai2' in (cfg.get('provider') or {}) else '(no account #2 login)'}")
PY

# Everything staged must be readable inside the container. Checking here beats
# discovering it as a 500 with no diagnostic later.
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +


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

# Last line of defence: no credential file reaches the container's config at all. The
# copy loop skips them by name; this proves it, because a reviewer's shell can read
# everything staged here.
LEAKED=$(find "$STAGE" -name service.json -o -name auth.json -o -name mcp-auth.json)
if [ -n "$LEAKED" ]; then
  echo "REFUSING: a credential file was staged for the container: $LEAKED" >&2
  exit 1
fi

echo "  staged at        : $STAGE"
