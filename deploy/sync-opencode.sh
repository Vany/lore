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
# 0644, not 0600: this file is bind-mounted into a container running under a
# different uid, and 0600 makes it unreadable there — opencode then starts with no
# providers and every tier fails as "not authenticated", pointing at the login
# rather than at the permission. The containing directory stays 0700, so nothing
# on the host gained access.
os.chmod(out_auth, 0o644)

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

# Everything staged must be readable by the container uid, which is not this one.
# Checking here beats discovering it as a 500 with no diagnostic later.
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

# Last line of defence: prove the staged credentials really are clean.
if grep -qi '"anthropic"' "$STAGE/data/auth.json"; then
  echo "REFUSING: an Anthropic credential survived into the staged auth.json" >&2
  exit 1
fi

echo "  staged at        : $STAGE"
