# The model transport.
#
# Built from npm rather than pulled: there is no official opencode image. The
# distribution is `opencode-ai` on the public registry, and pinning the version
# here means a review's behaviour does not change because upstream published on a
# Tuesday.

FROM node:24-bookworm-slim

# opencode explores the worktree it is pointed at, so it needs the tools a reader
# would use. It must NEVER need a writer's tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=1.18.11
RUN npm i -g "opencode-ai@${OPENCODE_VERSION}"

# Runs as a non-root user with THE SAME UID AS THE HOST OWNER of the staged files,
# which is also the uid the `lore` service runs as.
#
# This used to be 10001 and the comment above it already claimed they matched. They
# did not: `lore` runs as ${LORE_UID:-1000} and this was 10001. Reading survived the
# mismatch — the repo bind is read-only and the staged files are world-readable — so
# nothing complained, right up until a credential needed WRITING.
#
# The OpenAI credential is OAuth: it carries `expires` and `refresh`, and opencode
# renews it roughly hourly by rewriting auth.json. A file owned by the host user at
# 0644 is not writable by uid 10001, so reviews would have worked for about an hour
# and then failed looking like an expired subscription.
#
# `node:24-bookworm-slim` ships a `node` user already holding 1000, which is why the
# original chose 10001 to dodge the collision. Removing it is safe: nothing in this
# image runs as `node`, and dodging the collision is what created the bug.
ARG LORE_UID=1000
RUN userdel -r node 2>/dev/null || true \
 && useradd --create-home --uid "${LORE_UID}" lore

# opencode writes session state here (it creates `repos/` on first run), so the
# directory must exist AND be owned by the runtime user before the named volume is
# created from it: docker seeds a fresh volume from the image path, ownership
# included. Without this the volume lands root-owned and opencode dies with EACCES
# on a path nobody configured.
RUN mkdir -p /home/lore/.local/share/opencode /home/lore/.config/opencode \
 && chown -R lore:lore /home/lore

USER lore

EXPOSE 4096

# Credentials come from the environment. Verified: `opencode auth list` reports
# OPENROUTER_API_KEY as a recognised credential source with no auth.json present.
ENTRYPOINT ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
