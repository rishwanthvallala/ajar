"""sort, because the shipped coreutils does not have one.

`sharrattj/coreutils` is uutils 0.0.7 built as a multi-call binary, and `sort`
is not among the functions compiled into it — `sort file` answers
"file: function/utility not found", and so does `sort sort file`. The newer
`wasmer/coreutils@1.0.25` is the same build. The package that would fix it
properly, `kilyanni/coreutils` (GNU 9.11), cannot be installed from here.

So this stands in, the way `awk.py` does. The flags are the ones people
actually type. Anything else is refused rather than quietly ignored, because a
sort that silently drops `-k` is worse than one that admits it cannot.
"""

import sys

SUPPORTED = "-n -r -u -f -b -z -t SEP -k KEY -o FILE"


def die(message, code=2):
    sys.stderr.write(f"sort: {message}\n")
    raise SystemExit(code)


class Options:
    def __init__(self):
        self.numeric = False
        self.reverse = False
        self.unique = False
        self.fold = False
        self.blanks = False
        self.zero = False
        self.sep = None
        self.key = None
        self.out = None


def take_value(flag, rest, argv, i):
    """A value attached to the flag (`-t,`) or as the next argument (`-t ,`)."""
    if rest:
        return rest, i
    if i + 1 < len(argv):
        return argv[i + 1], i + 1
    die(f"option requires an argument -- '{flag}'")


def parse(argv):
    opts = Options()
    files = []
    short = {"n": "numeric", "r": "reverse", "u": "unique", "f": "fold", "b": "blanks", "z": "zero"}
    long = {
        "numeric-sort": "numeric",
        "reverse": "reverse",
        "unique": "unique",
        "ignore-case": "fold",
        "ignore-leading-blanks": "blanks",
        "zero-terminated": "zero",
    }
    valued = {"t": "sep", "k": "key", "o": "out"}
    long_valued = {"field-separator": "sep", "key": "key", "output": "out"}

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
            if name in long:
                setattr(opts, long[name], True)
            elif name in long_valued:
                if inline:
                    value = inline
                elif i + 1 < len(argv):
                    i += 1
                    value = argv[i]
                else:
                    die(f"option '--{name}' requires an argument")
                setattr(opts, long_valued[name], value)
            else:
                die(f"unsupported option '{arg}'. This shim supports: {SUPPORTED}")
        else:
            rest = arg[1:]
            while rest:
                flag, rest = rest[0], rest[1:]
                if flag in short:
                    setattr(opts, short[flag], True)
                elif flag in valued:
                    value, i = take_value(flag, rest, argv, i)
                    setattr(opts, valued[flag], value)
                    rest = ""
                else:
                    die(f"unsupported option '-{flag}'. This shim supports: {SUPPORTED}")
        i += 1
    return opts, files


def field_of(line, opts):
    """The part of the line a comparison looks at, honouring -k and -t."""
    if not opts.key:
        return line.lstrip() if opts.blanks else line
    start = opts.key.split(",")[0]
    # `-k2` and `-k2,3` and `-k2.1` all begin at field 2; only whole fields are
    # supported, and a character offset is refused rather than half-applied.
    if "." in start:
        die(f"unsupported key '{opts.key}': character offsets are not implemented")
    try:
        first = int(start)
    except ValueError:
        die(f"unsupported key '{opts.key}'")
    if first < 1:
        die("field number is zero")
    end = opts.key.split(",")[1] if "," in opts.key else None
    if end is not None and "." in end:
        die(f"unsupported key '{opts.key}': character offsets are not implemented")
    fields = line.split(opts.sep) if opts.sep is not None else line.split()
    last = int(end) if end is not None else first
    chosen = fields[first - 1 : last]
    joined = (opts.sep if opts.sep is not None else " ").join(chosen)
    return joined.lstrip() if opts.blanks else joined


def numeric_value(text):
    """GNU sorts anything unparseable as less than every number."""
    text = text.strip()
    taken = ""
    for ch in text:
        if ch.isdigit() or (ch in "+-" and not taken) or (ch == "." and "." not in taken):
            taken += ch
        else:
            break
    try:
        return float(taken)
    except ValueError:
        return float("-inf")


def key_for(line, opts):
    field = field_of(line, opts)
    if opts.numeric:
        return numeric_value(field)
    return field.lower() if opts.fold else field


def main(argv):
    opts, files = parse(argv)
    terminator = "\0" if opts.zero else "\n"

    text = ""
    if not files:
        text = sys.stdin.read()
    else:
        for name in files:
            if name == "-":
                text += sys.stdin.read()
                continue
            try:
                with open(name, "r", errors="surrogateescape") as handle:
                    text += handle.read()
            except OSError as e:
                die(f"cannot read: {name}: {e.strerror}", code=2)

    lines = text.split(terminator)
    if lines and lines[-1] == "":
        lines.pop()

    # Two passes rather than one comparison function: -u removes duplicates by
    # the *key*, which is not the same as removing duplicate lines.
    lines.sort(key=lambda line: key_for(line, opts), reverse=opts.reverse)
    if opts.unique:
        seen = set()
        kept = []
        for line in lines:
            k = key_for(line, opts)
            if k in seen:
                continue
            seen.add(k)
            kept.append(line)
        lines = kept

    body = "".join(line + terminator for line in lines)
    if opts.out:
        try:
            with open(opts.out, "w", errors="surrogateescape") as handle:
                handle.write(body)
        except OSError as e:
            die(f"cannot write: {opts.out}: {e.strerror}")
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
