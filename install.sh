#!/bin/sh
# ajar installer.
#
#   curl -sSf https://ajar.rishwanth.dev/install.sh | sh
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
have() { command -v "$1" >/dev/null 2>&1; }

target() {
    os=$(uname -s)
    arch=$(uname -m)

    case "$os" in
        Darwin) os_part="apple-darwin" ;;
        # Static, so it runs on any distribution — the glibc build needed a
        # glibc as new as the release machine's, and said nothing until run.
        Linux)  os_part="unknown-linux-musl" ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT)
            err "ajar does not support native Windows.

  Every mechanism it depends on works properly under WSL2 — install a Linux
  distribution, then run this from inside it:

      wsl --install
      # then, in the WSL shell:
      curl -sSf https://ajar.rishwanth.dev/install.sh | sh

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
    # $1 source, $2 destination. Why it failed lands in $TMP/why.
    case "$1" in
        /*|./*|../*) cp "$1" "$2" 2>"$TMP/why" ;;
        *)
            # Plenty of systems have wget and not curl — a fresh Debian or
            # Ubuntu among them — and someone who got this far found a way
            # to run it.
            if have curl; then
                curl -sSfL "$1" -o "$2" 2>"$TMP/why"
            else
                wget -q -O "$2" "$1" 2>"$TMP/why"
            fi
            ;;
    esac
}

# The line that puts $BIN_DIR on PATH, for the shell this person types in.
# ~/.profile was the advice for everyone, and zsh — every Mac's shell — never
# reads it, nor does fish, nor a bash that is not a login shell: a new
# terminal still said "command not found".
path_advice() {
    shell_name=$(basename "${SHELL:-sh}")
    case "$shell_name" in
        fish)
            say "  $BIN_DIR is not on your PATH. This adds it, now and for every new"
            say "  terminal:"
            say ""
            say "      fish_add_path $BIN_DIR"
            return
            ;;
        zsh) rc="~/.zshrc" ;;
        bash)
            # A Mac's terminal starts login shells, which read .bash_profile;
            # Linux terminals start the other kind, which read .bashrc.
            if [ "$(uname -s)" = Darwin ]; then rc="~/.bash_profile"; else rc="~/.bashrc"; fi
            ;;
        *) rc="~/.profile" ;;
    esac
    say "  $BIN_DIR is not on your PATH. For every new terminal:"
    say ""
    say "      echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> $rc"
    say ""
    say "  and for this one:"
    say ""
    say "      export PATH=\"\$PATH:$BIN_DIR\""
}

main() {
    need uname
    need tar
    # GNU tar hands the decompression to gzip, and a minimal image can have
    # one without the other.
    need gzip
    if [ -z "$DIST" ] && ! have curl && ! have wget; then
        err "curl or wget is required to download ajar, and neither is installed."
    fi

    TARGET=$(target)
    URL=$(resolve_url "$TARGET")

    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT INT TERM

    say ""
    say "  fetching ajar for $TARGET"

    if ! fetch "$URL" "$TMP/ajar.tar.gz"; then
        # Releases before 0.0.8 have only the glibc build for Linux.
        case "$TARGET" in
            *-linux-musl)
                older=$(printf '%s' "$TARGET" | sed 's/-musl$/-gnu/')
                if fetch "$(resolve_url "$older")" "$TMP/ajar.tar.gz"; then
                    TARGET=$older
                    URL=$(resolve_url "$older")
                    say "  this release has only the glibc build; using it"
                fi
                ;;
        esac
    fi
    if [ ! -s "$TMP/ajar.tar.gz" ]; then
        why=$(head -c 300 "$TMP/why" 2>/dev/null)
        err "could not download $URL
  ${why:-(no reason given)}

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

    # Run once here, so that a binary this machine cannot run is found out
    # now rather than at the first `ajar` — it used to say "installed" either
    # way.
    if ! version=$("$BIN_DIR/ajar" --version 2>"$TMP/why"); then
        why=$(head -c 400 "$TMP/why")
        err "installed $BIN_DIR/ajar, but it does not run on this machine:
  ${why:-(no reason given)}

  Please report this, with the output of \`uname -a\`:
      https://github.com/$REPO/issues"
    fi
    say "  installed $version to $BIN_DIR/ajar"
    say ""

    case ":$PATH:" in
        *":$BIN_DIR:"*)
            say "  try it:"
            say "      ajar ~/some/project"
            ;;
        *) path_advice ;;
    esac

    say ""
    say "  A guest gets a shell with your toolchain, confined by the operating"
    say "  system to the folder you share. It is a sandbox, not a virtual"
    say "  machine. Share with people you have some reason to trust."
    say ""
}

main "$@"
