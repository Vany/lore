# lore service image.
#
# arm64 on the deployment host (an Orange Pi), so every base image and every tool
# in here must have an arm64 build. That is the assumption PLAN.md §4.1 says to
# verify before trusting — it is asserted here, not proven.
#
# No build step: node >= 24 strips types and runs .ts directly, so the source IS
# the binary (D-3).

FROM node:24-bookworm-slim

# git for repository work on mirrors a HOST process populates; ca-certificates for the
# providers. semgrep and ast-grep are the T0 engines beyond tsc/eslint, which come
# from each target repo's own node_modules.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 python3-pip curl \
 && pip3 install --no-cache-dir --break-system-packages semgrep \
 && npm i -g @ast-grep/cli \
 && apt-get purge -y python3-pip && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# The docker CLIENT, and deliberately not Debian's `docker.io`, which would install
# a daemon this image must never run.
#
# T0 executes the target's test suite by asking the HOST daemon, over the mounted
# socket, to start a SIBLING container (D-24). The socket was mounted from the
# beginning and the client was not installed, so every attempt reported "docker not
# found" and the sandbox was unreachable from the one service that uses it — the
# engine reported it honestly and nothing else noticed for as long as tests were
# switched off.
#
# arm64 is the deployment target, so the architecture is derived rather than pinned.
ARG DOCKER_CLI_VERSION=27.5.1
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) a=x86_64 ;; arm64) a=aarch64 ;; *) echo "unsupported: $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "https://download.docker.com/linux/static/stable/$a/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
 && docker --version

RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
# Ladder configurations. LORE_TIERS points at one of these, so the file has to
# exist inside the image -- the container has no access to the checkout.
COPY deploy/tiers.*.json ./deploy/

# Reviews run as this user; the data volume is chowned to it in compose.
RUN useradd --system --create-home --uid 10001 lore
USER lore

ENV LORE_DATA_DIR=/var/lib/lore \
    LORE_PORT=7777 \
    NODE_ENV=production

EXPOSE 7777

# `lore` never execs a shell for user input, so no shell form here either.
ENTRYPOINT ["node", "/app/src/index.ts"]
CMD ["serve"]
