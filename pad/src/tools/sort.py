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

import os
import re
import sys
from decimal import Decimal

SUPPORTED = "-n -r -u -f -b -s -z -t SEP -k KEY -o FILE"


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
        self.stable = False
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
    short = {"n": "numeric", "r": "reverse", "u": "unique", "f": "fold", "b": "blanks", "z": "zero", "s": "stable"}
    long = {
        "numeric-sort": "numeric",
        "reverse": "reverse",
        "unique": "unique",
        "ignore-case": "fold",
        "ignore-leading-blanks": "blanks",
        "zero-terminated": "zero",
        "stable": "stable",
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
    # Where each field starts, in the line as it is: with -t, after each
    # separator; without, at each run of blanks before a word, which GNU
    # counts as part of the field. A key with no end runs to the end of the
    # line, as GNU's does — `-k2` stopped at field 2, so lines equal there
    # kept their order whatever followed (audit R3).
    if opts.sep is not None:
        starts = [0] + [m.end() for m in re.finditer(re.escape(opts.sep), line)]
        ends = [m.start() for m in re.finditer(re.escape(opts.sep), line)] + [len(line)]
    else:
        words = list(re.finditer(r"\s*\S+", line))
        starts = [m.start() for m in words]
        ends = [m.end() for m in words]
    if first > len(starts):
        return ""
    stop = len(line) if end is None or int(end) > len(ends) else ends[int(end) - 1]
    joined = line[starts[first - 1] : stop]
    return joined.lstrip() if opts.blanks else joined


def numeric_value(text):
    """
    A key's number as GNU's -n reads it: its leading number, and 0 for a key
    with none — so `word` sorts between -1 and 2, where this put it below
    every number. Exact, not a float: 9007199254740993 and 9007199254740992
    were equal as floats and kept their order (audit R3).
    """
    m = re.match(r"\s*(-?)(\d*)(?:\.(\d*))?", text)
    digits, fraction = m.group(2), m.group(3) or ""
    if not digits and not fraction:
        return Decimal(0)
    return Decimal((m.group(1) or "") + (digits or "0") + "." + (fraction or "0"))


def key_for(line, opts):
    field = field_of(line, opts)
    if opts.numeric:
        return numeric_value(field)
    return field.lower() if opts.fold else field


def order_for(line, opts):
    """
    The key, then — as GNU's last resort — the whole line, so lines equal by
    the key come out in a settled order rather than as they came; `-s` keeps
    them as they came.
    """
    return key_for(line, opts) if opts.stable else (key_for(line, opts), line)


def main(argv):
    opts, files = parse(argv)
    terminator = "\0" if opts.zero else "\n"

    # Each input's own lines: a file that does not end in a newline still ends
    # its last line. Read as one text, `z` with no newline and then `a` were
    # one line, `za` (audit R3).
    def lines_of(text):
        lines = text.split(terminator)
        if lines and lines[-1] == "":
            lines.pop()
        return lines

    lines = []
    if not files:
        lines = lines_of(sys.stdin.read())
    else:
        for name in files:
            if name == "-":
                lines += lines_of(sys.stdin.read())
                continue
            try:
                with open(name, "r", errors="surrogateescape") as handle:
                    lines += lines_of(handle.read())
            except OSError as e:
                die(f"cannot read: {name}: {e.strerror}", code=2)

    # Two passes rather than one comparison function: -u removes duplicates by
    # the *key*, which is not the same as removing duplicate lines.
    lines.sort(key=lambda line: order_for(line, opts), reverse=opts.reverse)
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
    try:
        code = main(sys.argv[1:])
        sys.stdout.flush()
    except BrokenPipeError:
        # The reader went — `| head` — which a real tool is told by SIGPIPE and
        # dies of quietly. Python flushes once more on its way out, and that
        # flush meeting the closed pipe printed "Exception ignored ...
        # BrokenPipeError" over the terminal; pointed at /dev/null it says nothing.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        code = 0
    raise SystemExit(code)
