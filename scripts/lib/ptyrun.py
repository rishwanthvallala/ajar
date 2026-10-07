#!/usr/bin/env python3
# Run a command inside a pseudo-terminal of a fixed size, so it behaves as it
# does for a person at a terminal: the agent shows its panel and reads keys.
#
# Bytes on our stdin go to the terminal; what the terminal prints comes out on
# our stdout, raw. COLS and ROWS set the size (default 220x50).
#
#   python3 scripts/lib/ptyrun.py target/debug/ajar <folder> --relay <url>
import fcntl, os, pty, select, signal, struct, sys, termios

cols, rows = int(os.environ.get("COLS", "220")), int(os.environ.get("ROWS", "50"))
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
os.kill(pid, signal.SIGWINCH)


def forward(sig, _frame):
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)
stdin_open = True
while True:
    try:
        ready, _, _ = select.select([fd] + ([0] if stdin_open else []), [], [], 0.5)
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    if 0 in ready:
        data = os.read(0, 1024)
        if data:
            os.write(fd, data)
        else:
            stdin_open = False
    done, _ = os.waitpid(pid, os.WNOHANG)
    if done:
        break
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
