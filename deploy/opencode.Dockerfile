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

# Runs as a non-root user with the same uid as `lore`, so the read-only bind of the
# repositories resolves to the same identity in both containers.
RUN useradd --system --create-home --uid 10001 lore

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
