#!/bin/sh
# ajar installer.
#
#   curl -sSf https://ajar.sh/install.sh | sh
#
# One binary, no runtime, nothing to configure. Installs to ~/.local/bin
# unless AJAR_BIN_DIR says otherwise.
#
# Testing against a local build:
#   AJAR_DIST=./dist sh install.sh

set -eu

REPO="${AJAR_REPO:-rishwanthvallala/ajar}"
VERSION="${AJAR_VERSION:-latest}"
BIN_DIR="${AJAR_BIN_DIR:-$HOME/.local/bin}"
# Point at a directory of tarballs instead of GitHub, for testing a build
# before it is a release.
DIST="${AJAR_DIST:-}"

say() { printf '%s\n' "$*"; }
err() { printf '\n  %s\n\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || err "$1 is required but not installed."; }

target() {
    os=$(uname -s)
    arch=$(uname -m)

    case "$os" in
        Darwin) os_part="apple-darwin" ;;
        Linux)  os_part="unknown-linux-gnu" ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT)
            err "ajar does not support native Windows.

  Every mechanism it depends on works properly under WSL2 — install a Linux
  distribution, then run this from inside it:

      wsl --install
      # then, in the WSL shell:
      curl -sSf https://ajar.sh/install.sh | sh

  Keep your projects in the WSL filesystem too. Sharing a folder on the
  Windows drive is roughly 20x slower for file operations."
            ;;
        *) err "unsupported operating system: $os" ;;
    esac

    case "$arch" in
        x86_64|amd64)  arch_part="x86_64" ;;
        arm64|aarch64) arch_part="aarch64" ;;
        *) err "unsupported architecture: $arch" ;;
    esac

    printf '%s-%s' "$arch_part" "$os_part"
}

resolve_url() {
    if [ -n "$DIST" ]; then
        printf '%s/ajar-%s.tar.gz' "$DIST" "$1"
    elif [ "$VERSION" = "latest" ]; then
        printf 'https://github.com/%s/releases/latest/download/ajar-%s.tar.gz' "$REPO" "$1"
    else
        printf 'https://github.com/%s/releases/download/%s/ajar-%s.tar.gz' "$REPO" "$VERSION" "$1"
    fi
}

fetch() {
    # $1 source, $2 destination
    case "$1" in
        /*|./*|../*) cp "$1" "$2" ;;
        *) curl -sSfL "$1" -o "$2" ;;
    esac
}

main() {
    need uname
    need tar
    [ -n "$DIST" ] || need curl

    TARGET=$(target)
    URL=$(resolve_url "$TARGET")

    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT INT TERM

    say ""
    say "  fetching ajar for $TARGET"

    if ! fetch "$URL" "$TMP/ajar.tar.gz" 2>/dev/null; then
        err "could not download $URL

  If this version has not been published for $TARGET yet, build from source:
      cargo install --git https://github.com/$REPO ajar"
    fi

    # Checksums are published beside the tarball. A missing one is not fatal
    # — a wrong one is.
    if fetch "$URL.sha256" "$TMP/ajar.tar.gz.sha256" 2>/dev/null; then
        expected=$(tr -d '\r\n ' < "$TMP/ajar.tar.gz.sha256" | cut -d' ' -f1)
        if command -v sha256sum >/dev/null 2>&1; then
            actual=$(sha256sum "$TMP/ajar.tar.gz" | cut -d' ' -f1)
        elif command -v shasum >/dev/null 2>&1; then
            actual=$(shasum -a 256 "$TMP/ajar.tar.gz" | cut -d' ' -f1)
        else
            actual=""
        fi
        if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
            err "checksum mismatch — refusing to install.
  expected $expected
  got      $actual"
        fi
        [ -n "$actual" ] && say "  checksum ok"
    fi

    tar -xzf "$TMP/ajar.tar.gz" -C "$TMP"
    [ -f "$TMP/ajar" ] || err "the archive did not contain an ajar binary"

    mkdir -p "$BIN_DIR"
    install -m 755 "$TMP/ajar" "$BIN_DIR/ajar" 2>/dev/null \
        || { cp "$TMP/ajar" "$BIN_DIR/ajar" && chmod 755 "$BIN_DIR/ajar"; }

    say "  installed $("$BIN_DIR/ajar" --version 2>/dev/null || echo ajar) to $BIN_DIR/ajar"
    say ""

    case ":$PATH:" in
        *":$BIN_DIR:"*)
            say "  try it:"
            say "      ajar ~/some/project"
            ;;
        *)
            say "  $BIN_DIR is not on your PATH. Add it:"
            say ""
            say "      echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> ~/.profile"
            say "      export PATH=\"\$PATH:$BIN_DIR\""
            ;;
    esac

    say ""
    say "  A guest gets a shell with your toolchain, confined by the operating"
    say "  system to the folder you share. It is a sandbox, not a virtual"
    say "  machine. Share with people you have some reason to trust."
    say ""
}

main "$@"
