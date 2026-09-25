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
mkdir -p "$HOME/.ssh" "$HOME/project" "$HOME/.cargo" "$HOME/.nvm"
echo "PRIVATE KEY MATERIAL" > "$HOME/.ssh/id_rsa"
# What a real .bashrc sources, and the credential that sits beside it.
echo 'export RUSTUP_SEEN=1' > "$HOME/.cargo/env"
echo 'export NVM_SEEN=1' > "$HOME/.nvm/nvm.sh"
echo "//registry.npmjs.org/:_authToken=NPM TOKEN MATERIAL" > "$HOME/.npmrc"
echo "hello" > "$HOME/project/inside.txt"
echo "not yours" > "$HOME/outside.txt"

failures=0
confined() { "$BIN" __confine "$HOME/project" net -- /bin/sh -c "$1" 2>&1 || true; }

check() { # label, command, predicate
    out=$(confined "$2")
    if eval "$3"; then
        echo "  ok    $1"
    else
        # An escape and a broken toolchain are both failures, but they are not
        # the same news, and the label says which kind of check this was.
        case "$1" in *"still works"*|*"can still"*) verdict=BROKE ;; *) verdict=LEAK ;; esac
        echo "  $verdict $1"
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

# Withheld, these made every guest shell open with "Permission denied" and
# left a host's nvm-installed node off the guest's PATH.
check "a shell can still source rustup's and nvm's setup" \
    ". $HOME/.cargo/env && . $HOME/.nvm/nvm.sh && echo \"seen:\$RUSTUP_SEEN\$NVM_SEEN\"" \
    'printf "%s" "$out" | grep -q "seen:11"'

check "cannot read the npm token beside them" \
    "cat $HOME/.npmrc" \
    '! printf "%s" "$out" | grep -q "NPM TOKEN MATERIAL"'

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

# truncate(2) takes a path and needs no open file, so the rights that stop a
# write never see it. Landlock only governs it from ABI 3, and only for a
# ruleset that asks. perl rather than coreutils `truncate`, which opens the file
# for writing first and so is refused for the wrong reason.
check "cannot truncate a file outside the folder" \
    "perl -e 'truncate(\"$HOME/outside.txt\", 0) or die \"refused: \$!\n\"'" \
    '[ -s $HOME/outside.txt ]'

# The rights that refuse the two above are granted inside the folder, and have
# to stay that way — a sandbox that breaks `sed -i` or `mv` gets switched off.
check "truncating inside the folder still works" \
    "cd $HOME/project && echo data > trunc.txt && perl -e 'truncate(\"trunc.txt\", 0) or die \"refused: \$!\n\"' && echo truncated-ok" \
    'printf "%s" "$out" | grep -q truncated-ok && [ ! -s $HOME/project/trunc.txt ]'

check "moving a file between folders inside it still works" \
    "cd $HOME/project && mkdir -p a b && echo m > a/moved.txt && perl -e 'rename(\"a/moved.txt\", \"b/moved.txt\") or die \"refused: \$!\n\"' && sed -i s/m/n/ b/moved.txt && echo moved-ok" \
    'printf "%s" "$out" | grep -q moved-ok && [ -f $HOME/project/b/moved.txt ]'

check "a job the guest started can still be stopped" \
    "sleep 300 & pid=\$!; kill \$pid && wait \$pid; echo stopped-rc=\$?" \
    'printf "%s" "$out" | grep -q "stopped-rc=143"'

# ---- what the running kernel can enforce -------------------------------
# landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) is syscall
# 444 on every architecture and answers with the ABI the kernel speaks.
abi=$(perl -e 'print syscall(444, 0, 0, 1)' 2>/dev/null || echo 0)
echo "  landlock abi $abi on this kernel"

# Scoped signals arrived in ABI 6 (Linux 6.12). Without them a guest can kill
# the agent, which ends the session for everyone, or anything else the host runs.
sleep 300 &
victim=$!
confined "kill -9 $victim" >/dev/null
if kill -0 "$victim" 2>/dev/null; then
    echo "  ok    cannot signal a process outside the sandbox"
    kill "$victim" 2>/dev/null || true
elif [ "$abi" -ge 6 ]; then
    echo "  LEAK  a confined shell killed a process outside the sandbox"
    failures=$((failures + 1))
else
    echo "  ~~    signals are not scoped on this kernel (landlock abi $abi, needs 6) — the agent says so"
fi


# ---- --no-network, which used to be accepted and enforce nothing --------
echo
# The probe has to be able to see a connection succeed, or its failure to see
# one proves nothing. `/dev/tcp` is a bash feature: under dash, which is /bin/sh
# on Debian and Ubuntu, it is just a path that does not exist, and every attempt
# "fails" whether or not the network is open.
probe='timeout 4 bash -c "exec 3<>/dev/tcp/1.1.1.1/80" 2>&1; echo "rc=$?"'
control=$("$BIN" __confine "$HOME/project" net -- /bin/sh -c "$probe" 2>&1 || true)
if ! printf '%s' "$control" | grep -q "rc=0"; then
    echo "  ~~    no outbound tcp even with the network allowed, so --no-network cannot be tested here"
elif "$BIN" __confine "$HOME/project" no-net -- /bin/sh -c 'exit 0' 2>/dev/null; then
    echo "  ok    the probe reaches the network when it is allowed"
    out=$("$BIN" __confine "$HOME/project" no-net -- /bin/sh -c "$probe" 2>&1 || true)
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
