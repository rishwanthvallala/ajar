#!/bin/sh
# Share the folder you are standing in, from a machine with nothing on it.
#
#     curl -sSf https://ajar.rishwanth.dev/run.sh | sh
#
# Installs ajar if it is missing, reuses it if it is not, and runs it against
# the relay that served this script. Arguments pass through after `-s --`:
#
#     curl -sSf https://ajar.rishwanth.dev/run.sh | sh -s -- --read-only
#     curl -sSf https://ajar.rishwanth.dev/run.sh | sh -s -- ~/some/project
#
# Nothing is written outside the install directory, and nothing is left
# running: ctrl-c ends the session the same as any other way of starting it.

set -eu

# The relay rewrites every occurrence of its own address when it serves this,
# so a self-hosted relay hands out a script that points at itself rather than
# at ours. Edited by hand, this is still a working script for the public one.
RELAY="${AJAR_RELAY:-https://ajar.rishwanth.dev}"
BIN_DIR="${AJAR_BIN_DIR:-$HOME/.local/bin}"

find_ajar() {
    if command -v ajar >/dev/null 2>&1; then
        command -v ajar
    elif [ -x "$BIN_DIR/ajar" ]; then
        printf '%s\n' "$BIN_DIR/ajar"
    fi
}

AJAR=$(find_ajar)
if [ -z "$AJAR" ]; then
    command -v curl >/dev/null 2>&1 || {
        echo "ajar: curl is needed to install" >&2
        exit 1
    }
    # To stderr, so that the only thing on stdout is the session link. That
    # matters the moment someone pipes this into something else.
    curl -sSf "$RELAY/install.sh" | sh >&2
    AJAR=$(find_ajar)
    [ -n "$AJAR" ] || {
        echo "ajar: installed, but no binary at $BIN_DIR/ajar" >&2
        exit 1
    }
fi

# Piped into `sh`, stdin is this script rather than the keyboard, so the panel
# would read its own source and exit. Borrow the real terminal instead.
#
# Tested by opening it, not with `[ -r /dev/tty ]`: the path exists and looks
# readable in a cron job, a CI step and a background shell, and the open then
# fails with ENXIO. Without a terminal the panel drops to plain output by
# itself, which is the right answer there anyway.
#
# The probe runs in a subshell, and that is load-bearing rather than style.
# `:` is a POSIX *special* built-in, and a redirection error on one of those
# makes the shell exit outright — so the bare form killed this script with a
# silent status 2 on every dash system, which is /bin/sh on Debian and
# Ubuntu. bash is lenient about it, so it looked fine everywhere it was
# written. A subshell keeps the exit inside the probe.
if (: < /dev/tty) 2>/dev/null; then
    exec "$AJAR" --relay "$RELAY" "$@" < /dev/tty
fi
exec "$AJAR" --relay "$RELAY" "$@"
