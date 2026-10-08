#!/bin/sh
# Run by check-first-run.sh inside a fresh Ubuntu container, as root, with the
# tarballs at /dist and install.sh and run.sh at /. $1 is the architecture.

set -u
fails=0
ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; }
check() { if [ "$1" = yes ]; then ok "$2"; else bad "$2${3:+ — $3}"; fi; }

apt-get update -qq >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zsh fish >/dev/null 2>&1

for shell in bash zsh fish; do
    user="u$shell"
    useradd -m -s "$(command -v "$shell")" "$user"
    out=$(su - "$user" -c 'AJAR_DIST=/dist sh /install.sh' 2>&1)
    check "$(printf '%s' "$out" | grep -q 'installed ajar' && echo yes)" "$shell: install.sh installs a binary that runs" "$out"
    case "$shell" in
        fish) line=$(printf '%s\n' "$out" | grep 'fish_add_path' | sed 's/^ *//') ;;
        *) line=$(printf '%s\n' "$out" | grep "^ *echo 'export PATH" | sed 's/^ *//') ;;
    esac
    # Done as printed, by the user's own shell — `su -` runs their login shell.
    [ -n "$line" ] && su - "$user" -c "$line" >/dev/null 2>&1
    # A new terminal tab: an interactive shell that is not a login shell.
    found=$(su "$user" -c "cd; env -i HOME=/home/$user PATH=/usr/bin:/bin TERM=xterm $shell -i -c 'command -v ajar'" 2>/dev/null)
    check "$([ -n "$found" ] && echo yes)" "$shell: a new terminal finds ajar after doing what install.sh said" "${line:-no advice printed}"
done

# The one-liner pasted into a fresh terminal, which starts in the home folder.
# This image has no curl, so the command it gives back is the wget one.
out=$(su - ubash -c 'sh /run.sh' 2>&1)
check "$(printf '%s' "$out" | grep -q 'in your home folder' && printf '%s' "$out" | grep -q 'wget -qO-' && echo yes)" \
    "run.sh in a fresh terminal says to go to the project first, in the command this machine has" "$out"

# A binary this machine cannot run is said at install, not at first use.
mkdir -p /tmp/bad/pkg
printf '#!/bin/sh\necho "cannot execute: wrong ELF class" >&2\nexit 126\n' > /tmp/bad/pkg/ajar
chmod 755 /tmp/bad/pkg/ajar
tar -czf "/tmp/bad/ajar-$1-unknown-linux-musl.tar.gz" -C /tmp/bad/pkg ajar
out=$(su - ubash -c 'AJAR_DIST=/tmp/bad AJAR_BIN_DIR=/tmp/badbin sh /install.sh' 2>&1)
status=$?
check "$([ $status -ne 0 ] && printf '%s' "$out" | grep -q 'does not run on this machine' && echo yes)" \
    "install.sh says so when the binary does not run" "status $status: $out"

echo "  done"
