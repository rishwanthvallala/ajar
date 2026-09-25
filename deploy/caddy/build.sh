#!/bin/sh
# Build the server's Caddy: the version in go.mod, with the rate-limit plugin.
#
#   deploy/caddy/build.sh                  # dist/caddy-linux-arm64, for the server
#   GOARCH=amd64 deploy/caddy/build.sh     # dist/caddy-linux-amd64, to try locally
#
# Prints the path it wrote. Needs Go on the deploying machine only; the server
# never gets a toolchain. Every module is checked against go.sum, which is
# committed, so a dependency that changed upstream fails the build instead of
# reaching production.
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
arch="${GOARCH:-arm64}"
out="dist/caddy-linux-$arch"
mkdir -p "$root/dist"

cd "$root/deploy/caddy"
# -buildvcs=false because this directory sits in the repository, and Go would
# otherwise stamp the commit into the binary. Every commit then built a
# different Caddy, so every deploy swapped it and restarted all three sites for
# a change that touched none of them. Without the stamp the bytes depend only
# on go.mod, go.sum and the Go release.
CGO_ENABLED=0 GOOS=linux GOARCH="$arch" GOFLAGS=-mod=readonly \
    go build -trimpath -buildvcs=false -ldflags "-s -w" -o "$root/$out" .

# The plugin is the only reason this binary exists. A build that somehow lost
# it would pass everything up to the first reload, and then fail it.
if [ "$arch" = "$(go env GOHOSTARCH)" ]; then
    "$root/$out" list-modules | grep -qx http.handlers.rate_limit || {
        echo "built $out without the rate_limit module" >&2
        exit 1
    }
fi
echo "$out"
