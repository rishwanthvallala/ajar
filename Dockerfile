# The relay: a static binary with the web client and the installer baked in.
# The agent is not in here — it runs on people's own machines, which is the
# entire point.

FROM node:24-alpine AS web
WORKDIR /w
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY pad/package.json pad/package.json
COPY packages/workspace-ui/package.json packages/workspace-ui/package.json
COPY packages/complete/package.json packages/complete/package.json
# No install scripts: the one that runs is bufferutil's, an optional native
# part of `ws` (the checks' WebSocket, nothing the page is built from), and
# with no prebuilt binary for arm64 and musl it wants Python and a compiler
# this image has not got — the build stopped here on a Graviton box or an
# Apple Silicon Mac. Nothing the build needs is made by a script.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY web/ web/
COPY packages/workspace-ui/ packages/workspace-ui/
# What the page is built from that is not under web/: the Suggest switch's
# engine, and the guide the page shows at /help.
COPY packages/complete/ packages/complete/
COPY docs/use/ajar.md docs/use/ajar.md
RUN npm run build:ajar

FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
# Cache the dependency build across source changes.
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY install.sh ./
COPY run.sh ./
RUN cargo build --release -p ajar-relay

FROM alpine:3
RUN apk add --no-cache ca-certificates \
    && adduser -D -H -u 10001 ajar \
    && mkdir -p /var/lib/ajar/pads \
    && chown -R ajar:ajar /var/lib/ajar
COPY --from=build /src/target/release/ajar-relay /usr/local/bin/ajar-relay
COPY --from=web /w/web/dist /srv/web
USER ajar
VOLUME ["/var/lib/ajar"]
EXPOSE 8787
ENV RUST_LOG=ajar_relay=info
HEALTHCHECK --interval=30s --timeout=3s \
    CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
# The accounts database beside the pads, in the volume, as the server's own
# unit has it: left to its default it is `./ajar-accounts.db`, which is `/`
# here, where this user can write nothing — and the relay stopped at start.
ENTRYPOINT ["ajar-relay", "--bind", "0.0.0.0:8787", "--web", "/srv/web", "--pad-dir", "/var/lib/ajar/pads", "--accounts-db", "/var/lib/ajar/accounts.db"]
