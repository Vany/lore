# The T0 test sandbox.
#
# Built rather than pulled because `node:*-alpine` ships **no git**, and a great
# many test suites need it — for version stamping, for fixtures, for tooling that
# shells out. Measured on the deployment host: with a bare node image, 10 of
# lore's own 180 tests failed; with git present, all 180 pass.
#
# That failure mode is the dangerous kind. The suite does not refuse to run — it
# runs and reports failures that have nothing to do with the change under review,
# and T0 turns those into high-severity findings. A reviewer that manufactures
# defects costs a fix cycle each and destroys trust in the real ones.
#
# This image holds NOTHING worth stealing. It never sees a deploy key, a token or
# the database (D-24).

FROM node:24-alpine

RUN apk add --no-cache git ca-certificates

# Many suites assume an identity exists when they touch git at all.
RUN git config --system user.email "sandbox@lore.invalid" \
 && git config --system user.name  "lore sandbox" \
 && git config --system --add safe.directory '*'

WORKDIR /work
