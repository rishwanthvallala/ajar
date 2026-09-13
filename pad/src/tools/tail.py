"""tail, for the same reason as sort.py: it is not in the shipped coreutils.

`tail -n 1 file` answers "-n: function/utility not found", and so does the
legacy `tail -1`. Both forms are in wide use, so both are implemented here.

`-f` is deliberately absent. Nothing in this sandbox appends to a file behind
your back — there are no other writers — so following would wait forever, and
a tail that never returns is worse than one that says it cannot follow.
"""

import sys

SUPPORTED = "-n N | -n +N | -N | -c N | -q | -v"


def die(message, code=2):
    sys.stderr.write(f"tail: {message}\n")
    raise SystemExit(code)


class Options:
    def __init__(self):
        self.count = 10
        self.from_start = False   # `-n +N` counts forward from the beginning
        self.bytes = False
        self.headers = None       # None means "only when there is more than one file"


def set_count(opts, value, is_bytes):
    opts.bytes = is_bytes
    if value.startswith("+"):
        opts.from_start = True
        value = value[1:]
    elif value.startswith("-"):
        value = value[1:]
    try:
        opts.count = int(value)
    except ValueError:
        die(f"invalid number of {'bytes' if is_bytes else 'lines'}: '{value}'")


def parse(argv):
    opts = Options()
    files = []
    i = 0
    only_files = False
    while i < len(argv):
        arg = argv[i]
        if only_files or arg == "-" or not arg.startswith("-"):
            files.append(arg)
        elif arg == "--":
            only_files = True
        elif arg.startswith("--"):
            name, _, inline = arg[2:].partition("=")
            if name in ("lines", "bytes"):
                if not inline:
                    if i + 1 >= len(argv):
                        die(f"option '--{name}' requires an argument")
                    i += 1
                    inline = argv[i]
                set_count(opts, inline, name == "bytes")
            elif name == "quiet" or name == "silent":
                opts.headers = False
            elif name == "verbose":
                opts.headers = True
            elif name == "follow":
                die("-f is not supported: nothing else writes to a file here")
            else:
                die(f"unsupported option '{arg}'. This shim supports: {SUPPORTED}")
        elif arg[1:].isdigit():
            # The legacy form: `tail -5` means `tail -n 5`.
            set_count(opts, arg[1:], False)
        else:
            rest = arg[1:]
            while rest:
                flag, rest = rest[0], rest[1:]
                if flag in ("n", "c"):
                    if rest:
                        value, rest = rest, ""
                    elif i + 1 < len(argv):
                        i += 1
                        value = argv[i]
                    else:
                        die(f"option requires an argument -- '{flag}'")
                    set_count(opts, value, flag == "c")
                elif flag == "q":
                    opts.headers = False
                elif flag == "v":
                    opts.headers = True
                elif flag == "f":
                    die("-f is not supported: nothing else writes to a file here")
                else:
                    die(f"unsupported option '-{flag}'. This shim supports: {SUPPORTED}")
        i += 1
    return opts, files


def tail_of(text, opts):
    if opts.bytes:
        if opts.from_start:
            return text[max(0, opts.count - 1) :]
        return text[-opts.count :] if opts.count else ""
    lines = text.splitlines(keepends=True)
    if opts.from_start:
        return "".join(lines[max(0, opts.count - 1) :])
    return "".join(lines[-opts.count :]) if opts.count else ""


def main(argv):
    opts, files = parse(argv)
    if not files:
        sys.stdout.write(tail_of(sys.stdin.read(), opts))
        return 0

    show = opts.headers if opts.headers is not None else len(files) > 1
    status = 0
    for index, name in enumerate(files):
        if name == "-":
            text = sys.stdin.read()
        else:
            try:
                with open(name, "r", errors="surrogateescape") as handle:
                    text = handle.read()
            except OSError as e:
                sys.stderr.write(f"tail: cannot open '{name}': {e.strerror}\n")
                status = 1
                continue
        if show:
            sys.stdout.write(("\n" if index else "") + f"==> {name} <==\n")
        sys.stdout.write(tail_of(text, opts))
    return status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
