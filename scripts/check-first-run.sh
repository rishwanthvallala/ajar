#!/bin/sh
# Someone else's first install: the static Linux build on the distributions
# people actually have, and what the installer tells a new user.
#
# Written on 8 October, after fresh containers of fifteen distributions found
# the release's Linux binary ran on three of them — it needed the glibc of the
# machine that built it, and the installer said "installed" either way — and
# that the PATH advice it printed worked in no new terminal but a login bash.
#
#   ./scripts/dist.sh && ./scripts/check-first-run.sh dist
#       the binary on each distribution, and install.sh and run.sh as a new
#       user would meet them, in containers (docker or podman)
#   ./scripts/check-first-run.sh --here dist
#       install.sh on this machine, into a throwaway home: the advice for
#       zsh and bash followed, and a new terminal finding ajar — the half a
#       container cannot do for a Mac
#
# `dist` holds the tarballs `scripts/dist.sh` makes: for the containers,
# ajar-<arch>-unknown-linux-musl.tar.gz for the containers' architecture.

set -eu
cd "$(dirname "$0")/.."

fails=0
ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
check() { if [ "$1" = yes ]; then ok "$2"; else bad "$2${3:+ — $3}"; fi; }

here() {
    dist=$(cd "$1" && pwd)
    for shell in zsh bash; do
        command -v "$shell" >/dev/null 2>&1 || { echo "  skip  $shell — not installed"; continue; }
        home=$(mktemp -d)
        out=$(env -i HOME="$home" PATH=/usr/bin:/bin SHELL="$(command -v "$shell")" \
            AJAR_DIST="$dist" sh install.sh 2>&1) || true
        check "$(printf '%s' "$out" | grep -q 'installed ajar' && echo yes)" \
            "$shell: install.sh installs a binary that runs" "$out"
        line=$(printf '%s\n' "$out" | grep "^ *echo 'export PATH" | sed 's/^ *//')
        [ -n "$line" ] && env -i HOME="$home" PATH=/usr/bin:/bin "$shell" -c "$line"
        # A Mac's terminal starts login shells; Linux terminals, interactive
        # ones. The advice has to hold for whichever this machine starts.
        if [ "$(uname -s)" = Darwin ]; then flags=-il; else flags=-i; fi
        found=$(cd "$home" && env -i HOME="$home" PATH=/usr/bin:/bin TERM=xterm \
            "$shell" $flags -c 'command -v ajar' 2>/dev/null) || true
        check "$([ -n "$found" ] && echo yes)" \
            "$shell: a new terminal finds ajar after doing what install.sh said" "${line:-no advice printed}"
        rm -rf "$home"
    done
}

containers() {
    dist=$(cd "$1" && pwd)
    # Whichever answers: a Mac can have the docker command with no daemon
    # behind it, and podman doing the work.
    engine=""
    for candidate in docker podman; do
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" info >/dev/null 2>&1; then
            engine=$candidate
            break
        fi
    done
    [ -n "$engine" ] || { echo "  needs a working docker or podman" >&2; exit 1; }
    case "$(uname -m)" in
        arm64|aarch64) arch=aarch64 platform=linux/arm64 ;;
        *) arch=x86_64 platform=linux/amd64 ;;
    esac
    tarball="$dist/ajar-$arch-unknown-linux-musl.tar.gz"
    [ -f "$tarball" ] || { echo "  no $tarball — run scripts/dist.sh" >&2; exit 1; }
    bin=$(mktemp -d)
    tar -xzf "$tarball" -C "$bin"

    # Old, new, glibc and musl. Debian 11 is past its end of life and its
    # mirror has moved, but it is still installed on plenty of machines.
    for image in \
        docker.io/library/ubuntu:20.04 docker.io/library/ubuntu:22.04 docker.io/library/ubuntu:24.04 \
        docker.io/library/debian:11 docker.io/library/debian:12 \
        docker.io/rockylinux/rockylinux:8 docker.io/rockylinux/rockylinux:9 \
        registry.fedoraproject.org/fedora:41 \
        docker.io/library/amazonlinux:2 docker.io/library/amazonlinux:2023 \
        docker.io/opensuse/leap:15.6 docker.io/library/alpine:3.20; do
        out=$("$engine" run --rm --platform "$platform" -v "$bin:/d:ro" "$image" /d/ajar --version 2>&1 | tail -1)
        check "$(printf '%s' "$out" | grep -q '^ajar ' && echo yes)" "runs on ${image##*/}" "$out"
    done

    # What a new user is told, in each shell, followed to the letter.
    "$engine" run --rm --platform "$platform" \
        -v "$dist:/dist:ro" -v "$PWD/install.sh:/install.sh:ro" -v "$PWD/run.sh:/run.sh:ro" \
        -v "$PWD/scripts/lib/first-run-inside.sh:/inside.sh:ro" \
        docker.io/library/ubuntu:24.04 sh /inside.sh "$arch" > "$bin/inside.log" 2>&1 || true
    cat "$bin/inside.log"
    fails=$((fails + $(grep -c '^  FAIL' "$bin/inside.log" || true)))
    grep -q '^  done' "$bin/inside.log" || bad "the in-container checks did not finish"
    rm -rf "$bin"
}

case "${1:-}" in
    --here) here "${2:-dist}" ;;
    *) containers "${1:-dist}" ;;
esac

if [ "$fails" -gt 0 ]; then
    printf '\n  %s failed\n' "$fails"
    exit 1
fi
printf '\n  a first install works\n'
