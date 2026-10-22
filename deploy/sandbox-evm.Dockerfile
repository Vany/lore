# The T0 sandbox for Ethereum projects (Solidity / EVM).
#
# A SEPARATE IMAGE from `sandbox.Dockerfile`, not more layers on it: that one runs for every
# JS review on this deployment, and foundry + python + slither would make every one of them
# pay to pull and start what only a contracts repository uses.
#
# Debian, not alpine: foundry's and aderyn's linux builds are glibc (checked against the
# v1.8.5 and aderyn-v0.6.8 release assets, 2026-10-20), and the host's docker is arm64, which
# both publish. Node stays in, because many foundry repos keep dependencies in node_modules
# and hardhat projects are node projects.
#
# VERSIONS ARE PINNED, read from each project's GitHub releases on 2026-10-20. A sandbox that
# floats would let a tool upgrade change what a review finds without anything in this
# repository changing — a review must be reproducible from the tree and this file.
#
# NO KEYS, NO RPC. Nothing here may hold a mainnet RPC URL or a private key: a test suite
# that forks mainnet fails here, and that is reported as the test not running, never routed
# around. Only the install phase has network (dependency clones, solc downloads); build, test
# and analysis run with `--network none`, so the only chain a test can reach is a local anvil
# it starts itself.
#
# This image holds NOTHING worth stealing (D-24).

# By DIGEST, not tag: the tag floats, and a base that moves is a sandbox that moves.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

ARG FOUNDRY_VERSION=v1.8.5
ARG SLITHER_VERSION=0.11.6
ARG SOLHINT_VERSION=6.2.5
ARG ADERYN_VERSION=aderyn-v0.6.8
ARG TARGETARCH

# Downloads RESUME and retry: the first build of this image died at curl exit 18 (the link
# dropped mid-file) on a 130 MB tarball. The sha256 check below still decides what is kept.
ARG CURL="curl -fsSL --retry 20 --retry-all-errors --retry-delay 5 -C -"

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

# forge, cast, anvil, chisel — the release tarball, checked against its own published sha256.
RUN set -eu; \
    arch="$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo amd64)"; \
    base="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}"; \
    file="foundry_${FOUNDRY_VERSION}_linux_${arch}.tar.gz"; \
    ${CURL} -o "/tmp/${file}" "${base}/${file}"; \
    ${CURL} -o /tmp/foundry.sha256 "${base}/foundry_${FOUNDRY_VERSION}_linux_${arch}.sha256"; \
    (cd /tmp && grep -q "$(sha256sum "${file}" | cut -d' ' -f1)" foundry.sha256) \
      || { echo "foundry tarball does not match its published sha256" >&2; exit 1; }; \
    tar -xzf "/tmp/${file}" -C /usr/local/bin forge cast anvil chisel; \
    rm -f /tmp/foundry*; \
    forge --version

# aderyn — Cyfrin's static analyser, also checked against its published sha256.
RUN set -eu; \
    triple="$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64)-unknown-linux-gnu"; \
    base="https://github.com/Cyfrin/aderyn/releases/download/${ADERYN_VERSION}"; \
    ${CURL} -o /tmp/aderyn.tar.xz "${base}/aderyn-${triple}.tar.xz"; \
    ${CURL} -o /tmp/aderyn.sha256 "${base}/aderyn-${triple}.tar.xz.sha256"; \
    [ "$(sha256sum /tmp/aderyn.tar.xz | cut -d' ' -f1)" = "$(cut -d' ' -f1 /tmp/aderyn.sha256)" ] \
      || { echo "aderyn tarball does not match its published sha256" >&2; exit 1; }; \
    mkdir -p /tmp/aderyn && tar -xJf /tmp/aderyn.tar.xz -C /tmp/aderyn; \
    find /tmp/aderyn -type f -name aderyn -exec install -m 0755 {} /usr/local/bin/aderyn \; ; \
    rm -rf /tmp/aderyn*; \
    aderyn --version

# slither in its own venv, so the system python is untouched; solc comes from forge's cache at
# run time (slither compiles through `forge build`), so no solc-select is needed.
# EVERY python package pinned (`sandbox-evm-requirements.txt`, the freeze of the image that
# was demonstrated), `--no-deps` so nothing outside it can be resolved: crytic-compile in
# particular decides whether slither can read forge's build-info at all.
COPY deploy/sandbox-evm-requirements.txt /tmp/slither-requirements.txt
RUN python3 -m venv /opt/slither \
 && grep -qx "slither-analyzer==${SLITHER_VERSION}" /tmp/slither-requirements.txt \
 && /opt/slither/bin/pip install --no-cache-dir --no-deps --retries 20 --timeout 120 -r /tmp/slither-requirements.txt \
 && ln -s /opt/slither/bin/slither /usr/local/bin/slither \
 && slither --version

RUN npm i -g --no-audit --no-fund "solhint@${SOLHINT_VERSION}" pnpm@10.34.7 && solhint --version

# Declared HERE, not at the top: an ARG declared above a cached step invalidates it, and the
# first time that happened the rebuild re-downloaded foundry's 130 MB over a crawling link.
# BY COMMIT and BY HASH, like everything else here: a tag can be moved by anyone who can push,
# and a moved forge-std or bug list would change every hardhat PoC's compile and every
# solc-bugs report with nothing in this repository changing.
ARG FORGE_STD_VERSION=v1.17.0
ARG FORGE_STD_COMMIT=f3dae6e6ee381f25eb6a246f7da9b85c91a68219
# The Solidity team's own list of known compiler bugs, at a pinned release: it covers every
# compiler up to that release, which is what `solc-bugs` matches a project's versions against.
ARG SOLC_BUGS_TAG=v0.8.37
ARG SOLC_BUGS_SHA256=ee8e0a9d7b2b54914eda10f4533d3c2f1136176bd99df2b2abb4c25a4548a582
ARG SOLC_BUGS_BY_VERSION_SHA256=e67aba151b323ead83f8816f7bae875f04f1eb4defdc9895133b89f8712631f1

# forge-std, offline: a forge PoC in a HARDHAT project has no lib/ of its own to import it from.
RUN git clone --quiet --depth 1 --branch "${FORGE_STD_VERSION}" https://github.com/foundry-rs/forge-std /opt/forge-std \
 && [ "$(git -C /opt/forge-std rev-parse HEAD)" = "${FORGE_STD_COMMIT}" ] \
 || { echo "forge-std ${FORGE_STD_VERSION} is not the pinned commit ${FORGE_STD_COMMIT}" >&2; exit 1; } \
 && rm -rf /opt/forge-std/.git

RUN mkdir -p /opt/solc-bugs \
 && ${CURL} -o /opt/solc-bugs/bugs.json "https://raw.githubusercontent.com/argotorg/solidity/${SOLC_BUGS_TAG}/docs/bugs.json" \
 && ${CURL} -o /opt/solc-bugs/bugs_by_version.json "https://raw.githubusercontent.com/argotorg/solidity/${SOLC_BUGS_TAG}/docs/bugs_by_version.json" \
 && echo "${SOLC_BUGS_SHA256}  /opt/solc-bugs/bugs.json" | sha256sum -c - \
 && echo "${SOLC_BUGS_BY_VERSION_SHA256}  /opt/solc-bugs/bugs_by_version.json" | sha256sum -c -

RUN git config --system user.email "sandbox@lore.invalid" \
 && git config --system user.name  "lore sandbox" \
 && git config --system --add safe.directory '*'

WORKDIR /work
