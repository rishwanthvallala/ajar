# The relay: a static binary with the web client and the installer baked in.
# The agent is not in here — it runs on people's own machines, which is the
# entire point.

FROM node:24-alpine AS web
WORKDIR /w
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY pad/package.json pad/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci --no-audit --no-fund
COPY web/ web/
COPY packages/ packages/
RUN npm run build:ajar

FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
# Cache the dependency build across source changes.
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY install.sh ./
RUN cargo build --release -p ajar-relay

FROM alpine:3
RUN apk add --no-cache ca-certificates \
    && adduser -D -H -u 10001 ajar
COPY --from=build /src/target/release/ajar-relay /usr/local/bin/ajar-relay
COPY --from=web /w/web/dist /srv/web
USER ajar
EXPOSE 8787
ENV RUST_LOG=ajar_relay=info
HEALTHCHECK --interval=30s --timeout=3s \
    CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
ENTRYPOINT ["ajar-relay", "--bind", "0.0.0.0:8787", "--web", "/srv/web"]
