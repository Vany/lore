# The model transport.
#
# Built from npm rather than pulled. opencode 2.x is `@opencode/cli` on the public
# registry — NOT `opencode-ai`, which is the 1.x line and still publishes as `latest`
# there; installing that name gets a server whose HTTP API lore no longer speaks.
#
# THE VERSION IS THE HOST'S, passed in by `make up` from `opencode --version` (the brew
# install the operator logs in with). One version on both sides because credentials move
# between them as opencode's own records (`make sync-creds`), and a record written by one
# version is only promised to the same one. No default on purpose: a build that does not
# know which opencode to install must stop, not quietly pick one.

FROM node:24-bookworm-slim

# opencode explores the worktree it is pointed at, so it needs the tools a reader
# would use. It must NEVER need a writer's tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION
RUN case "${OPENCODE_VERSION}" in \
      2.*) ;; \
      *) echo "OPENCODE_VERSION='${OPENCODE_VERSION}' — lore speaks opencode 2.x; build through 'make up', which reads the host's" >&2; exit 1 ;; \
    esac \
 && npm i -g "@opencode/cli@${OPENCODE_VERSION}" \
 && opencode --version

# Runs as a non-root user with THE SAME UID AS THE HOST OWNER of the staged files,
# which is also the uid the `lore` service runs as.
#
# This used to be 10001 and the comment above it already claimed they matched. They
# did not: `lore` runs as ${LORE_UID:-1000} and this was 10001. Reading survived the
# mismatch — the repo bind is read-only and the staged files are world-readable — so
# nothing complained, right up until a credential needed WRITING.
#
# The OpenAI credential is OAuth: it carries `expires` and `refresh`, and opencode
# renews it itself. It once lived in a host-owned file opencode had to rewrite, which
# uid 10001 could not — reviews worked for about an hour and then failed looking like an
# expired subscription. v2 keeps credentials in its database instead, but every staged
# file this container reads is still the host user's, so the uids still have to match.
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

# Credentials live in opencode's own database on the `opencode2-data` volume and arrive
# through its API (`make sync-creds`); a provider key in the environment works too —
# v2 lists `env` as a connection method for each provider that has one.
ENTRYPOINT ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
