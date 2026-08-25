#!/usr/bin/env bash
# Attack the Linux sandbox.
#
# Landlock confines the calling process, so the agent re-execs itself as a
# launcher that restricts and then becomes the shell. This runs that launcher
# and tries to get out of it.
#
# On Linux it runs directly. Anywhere else it needs a Linux kernel, so it
# borrows one from podman or docker — which is not a workaround: Landlock is a
# kernel feature and there is nothing to test without one.
#
#   ./scripts/linux-sandbox.sh

set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Linux" ]; then
    runtime=""
    for candidate in podman docker; do
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" info >/dev/null 2>&1; then
            runtime="$candidate"
            break
        fi
    done
    if [ -z "$runtime" ]; then
        echo "  skip  no Linux kernel available (podman or docker would provide one)"
        exit 0
    fi
    echo "  borrowing a Linux kernel from $runtime"
    exec "$runtime" run --rm -i -v "$PWD":/src:ro docker.io/library/rust:slim \
        bash /dev/stdin < "$0"
fi

# ---- from here down we are on Linux ------------------------------------
cd /src 2>/dev/null || true
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/tmp/ajar-linux-target}

echo "  kernel $(uname -r)"
cargo build --quiet -p ajar
BIN="$CARGO_TARGET_DIR/debug/ajar"

# The fixture home has to sit where a real one does.
#
# Landlock is allow-list only, so the implementation withholds the top-level
# directory that HOME lives under. Putting the fixture in /tmp defeats that —
# /tmp is granted writable so toolchains work, and the fake home came back
# into view. That was the fixture being unrealistic, not the sandbox failing.
WORK=$(mktemp -d "$HOME/.ajar-sandbox-test-XXXXXX")
export HOME="$WORK/home"
mkdir -p "$HOME/.ssh" "$HOME/project"
echo "PRIVATE KEY MATERIAL" > "$HOME/.ssh/id_rsa"
echo "hello" > "$HOME/project/inside.txt"
echo "not yours" > "$HOME/outside.txt"

failures=0
confined() { "$BIN" __confine "$HOME/project" net -- /bin/sh -c "$1" 2>&1 || true; }

check() { # label, command, predicate
    out=$(confined "$2")
    if eval "$3"; then
        echo "  ok    $1"
    else
        echo "  LEAK  $1"
        echo "        $(printf '%s' "$out" | head -c 160)"
        failures=$((failures + 1))
    fi
}

check "ordinary work inside the folder still works" \
    "cd $HOME/project && echo written > new.txt && cat new.txt" \
    "[ -f $HOME/project/new.txt ]"

check "cannot write outside the folder" \
    "echo x > $HOME/escaped.txt" \
    "[ ! -f $HOME/escaped.txt ]"

check "cannot delete outside the folder" \
    "rm -f $HOME/outside.txt" \
    "[ -f $HOME/outside.txt ]"

check "cannot read ssh keys" \
    "cat $HOME/.ssh/id_rsa" \
    '! printf "%s" "$out" | grep -q "PRIVATE KEY MATERIAL"'

# Landlock is allow-list only, so the whole home directory is invisible apart
# from the few config paths that are handed back. That is stricter than the
# macOS profile, which denies a named list.
check "cannot even list the home directory" \
    "ls $HOME" \
    '! printf "%s" "$out" | grep -q "outside.txt"'

check "system paths stay readable, so toolchains work" \
    "cat /etc/hostname" \
    '! printf "%s" "$out" | grep -qi "permission denied"'

# The three ways out that actually worried me. Landlock resolves paths, so
# none of them reach a hierarchy that was never granted.
check "cannot escape through /proc/self/root" \
    "cat /proc/self/root$HOME/.ssh/id_rsa" \
    '! printf "%s" "$out" | grep -q "PRIVATE KEY MATERIAL"'

check "cannot escape through a symlink out of the project" \
    "ln -sf $HOME/.ssh $HOME/project/link 2>/dev/null; cat $HOME/project/link/id_rsa" \
    '! printf "%s" "$out" | grep -q "PRIVATE KEY MATERIAL"'

check "cannot escape with .. out of the project" \
    "cat $HOME/project/../.ssh/id_rsa" \
    '! printf "%s" "$out" | grep -q "PRIVATE KEY MATERIAL"'


# ---- --no-network, which used to be accepted and enforce nothing --------
echo
if "$BIN" __confine "$HOME/project" no-net -- /bin/sh -c 'exit 0' 2>/dev/null; then
    out=$("$BIN" __confine "$HOME/project" no-net -- /bin/sh -c \
        'timeout 4 sh -c "exec 3<>/dev/tcp/1.1.1.1/80" 2>&1; echo "rc=$?"' 2>&1 || true)
    if printf '%s' "$out" | grep -q "rc=0"; then
        echo "  LEAK  --no-network was accepted but outbound tcp still worked"
        failures=$((failures + 1))
    else
        echo "  ok    --no-network actually refuses outbound tcp"
    fi
    # And the same shell must still work locally, or the flag is useless.
    if "$BIN" __confine "$HOME/project" no-net -- /bin/sh -c 'echo local-ok' 2>/dev/null | grep -q local-ok; then
        echo "  ok    the shell still runs with the network cut"
    else
        echo "  LEAK  the shell would not start with --no-network"
        failures=$((failures + 1))
    fi
else
    echo "  ~~    --no-network refused outright on this kernel (needs 6.7+), which is the honest answer"
fi

rm -rf "$WORK"
echo
if [ "$failures" -ne 0 ]; then
    echo "  $failures escape(s) succeeded"
    exit 1
fi
echo "  the linux sandbox holds"
