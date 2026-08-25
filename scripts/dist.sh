#!/usr/bin/env bash
# Build release tarballs for whatever targets this machine can produce.
#
#   ./scripts/dist.sh            # host target only
#   ./scripts/dist.sh --all      # every target with a toolchain installed
#
# Output lands in dist/ as ajar-<target>.tar.gz plus a .sha256 beside each,
# which is exactly the layout install.sh expects.

set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

OUT=dist
mkdir -p "$OUT"

host_target() {
    rustc -vV | awk '/^host: /{print $2}'
}

candidates() {
    if [ "${1:-}" = "--all" ]; then
        printf '%s\n' \
            aarch64-apple-darwin \
            x86_64-apple-darwin \
            x86_64-unknown-linux-gnu \
            aarch64-unknown-linux-gnu
    else
        host_target
    fi
}

checksum() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

built=0
for target in $(candidates "${1:-}"); do
    if ! rustc --print target-list | grep -qx "$target"; then
        echo "  skip  $target — unknown to this rustc"
        continue
    fi
    if ! cargo build --release --target "$target" -p ajar 2>/dev/null; then
        echo "  skip  $target — no toolchain (rustup target add $target)"
        continue
    fi

    bin="target/$target/release/ajar"
    tarball="$OUT/ajar-$target.tar.gz"
    tar -czf "$tarball" -C "$(dirname "$bin")" ajar
    checksum "$tarball" > "$tarball.sha256"
    echo "  ok    $tarball  ($(checksum "$tarball" | cut -c1-12)…)"
    built=$((built + 1))
done

if [ "$built" -eq 0 ]; then
    echo "  nothing built" >&2
    exit 1
fi

echo
echo "  test the installer against these without publishing anything:"
echo "      AJAR_DIST=\$PWD/$OUT AJAR_BIN_DIR=/tmp/ajar-bin sh install.sh"
