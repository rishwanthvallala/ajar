"""go and gofmt, handed paths they can open.

The Go toolchain the pad fetches (golang/go, 1.25.5 built for WASIX) cannot
open a relative path: `go run main.go` answers "stat main.go: Bad file number".
Nor can it learn its working directory, so a module — `go mod init`, then
`go run .` — answers "getwd: File name too long". Given absolute paths, a
single-file program runs and builds (measured 12 October).

So this makes every argument that names a Go file, and the path after `-o`,
absolute from the shell's directory, and runs the real command with them —
from the folder root, because below it Go cannot learn its working directory
either (`cd sub && go run m.go` failed so). `go run main.go` and
`go build -o hello main.go` work from anywhere; a module does not, and says
why in Go's own words.
"""

import os
import subprocess
import sys

# Where Go can tell where it is; every path it is given is absolute by then.
ROOT = "/workspace"

# Flags whose next argument is a path.
PATH_FLAGS = {"-o", "-modfile", "-coverprofile", "-cpuprofile", "-memprofile"}


def absolute(arg, here):
    return arg if arg.startswith("/") else os.path.normpath(os.path.join(here, arg))


def rewrite(args, here):
    out = []
    path_next = False
    for arg in args:
        if path_next:
            out.append(absolute(arg, here))
            path_next = False
        elif arg in PATH_FLAGS:
            out.append(arg)
            path_next = True
        elif "=" in arg and arg.split("=", 1)[0] in PATH_FLAGS:
            flag, value = arg.split("=", 1)
            out.append(f"{flag}={absolute(value, here)}")
        elif not arg.startswith("-") and arg.endswith(".go"):
            out.append(absolute(arg, here))
        else:
            out.append(arg)
    return out


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: go.py go|gofmt [args]\n")
        return 2
    command, args = sys.argv[1], sys.argv[2:]
    try:
        return subprocess.run([command, *rewrite(args, os.getcwd())], cwd=ROOT).returncode
    except FileNotFoundError:
        sys.stderr.write(f"{command}: not here yet — type it again once Go has been fetched\n")
        return 127
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
