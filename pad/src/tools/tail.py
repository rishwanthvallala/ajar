"""tail, for the same reason as sort.py: it is not in the shipped coreutils.

`tail -n 1 file` answers "-n: function/utility not found", and so does the
legacy `tail -1`. Both forms are in wide use, so both are implemented here, as
GNU tail 9.4 has them: counts with GNU's suffixes (`-n 1k` is 1024 lines), the
legacy `-N` and `+N` only where GNU takes them — first, with at most one file
— and everything in bytes. A line ends at a newline and nowhere else: until
20 October a CR, a form feed or U+2028 ended one too, a file's CRLFs came out
as LFs, and -c counted characters.

`-f` is deliberately absent. Nothing in this sandbox appends to a file behind
your back — there are no other writers — so following would wait forever, and
a tail that never returns is worse than one that says it cannot follow.
"""

import os
import re
import stat
import sys
from collections import deque

SUPPORTED = "-n [+]N | -c [+]N | -N | +N | -q | -v | -z (N may end in b, K, M, G, ... kB, MB, ...)"
UINTMAX = 2**64 - 1
BLOCK = 1 << 16
FOLLOW = "-f is not supported: nothing else writes to a file here"


def warn(message):
    # What came before it is printed first, as it is when GNU's stdout is a terminal.
    sys.stdout.flush()
    sys.stderr.write(f"tail: {message}\n")


def die(message, code=1):
    warn(message)
    raise SystemExit(code)


def quote(name):
    """A name in a message as GNU quotes it: in single quotes, or double if it has one."""
    if "'" in name and not any(c in name for c in '"$`\\'):
        return f'"{name}"'
    return "'" + name.replace("'", "'\\''") + "'"


class Options:
    def __init__(self):
        self.count = 10
        self.from_start = False   # `-n +N` counts forward from the beginning
        self.lines = True         # False for -c
        self.headers = None       # None means "only when there is more than one file"
        self.zero = False


# Every long option GNU tail 9.4 has, so that an abbreviation resolves, or is
# ambiguous, exactly as it would there. A name of None is refused here.
LONG = {
    "bytes": (True, "c"),
    "follow": ("optional", None),
    "help": (False, "help"),
    "lines": (True, "n"),
    "max-unchanged-stats": (True, "max-unchanged-stats"),
    "pid": (True, "pid"),
    "quiet": (False, "q"),
    "retry": (False, "retry"),
    "silent": (False, "q"),
    "sleep-interval": (True, "s"),
    "verbose": (False, "v"),
    "version": (False, None),
    "zero-terminated": (False, "z"),
}
POWERS = {"k": 1, "K": 1, "m": 2, "M": 2, "G": 3, "T": 4, "P": 5, "E": 6, "Z": 7, "Y": 8, "R": 9, "Q": 10}


def count_of(text, what):
    """
    A count as GNU reads one: decimal, then perhaps a multiplier — b for 512,
    K, M, G ... Q for powers of 1024, or of 1000 written kB, MB ... — and no
    more than 2^64 - 1.
    """
    if text.lstrip(" \t\n\v\f\r").startswith("-"):
        die(f"{what}: {quote(text)}")
    m = re.match(r"[ \t\n\v\f\r]*\+?([0-9]+)", text)
    if m:
        value, rest = int(m.group(1)), text[m.end():]
    elif text[:1] and text[0] in "bkKmMGTPEZYRQ":
        value, rest = 1, text
    else:
        die(f"{what}: {quote(text)}")
    if rest:
        unit = rest[0]
        if unit not in "bkKmMGTPEZYRQ":
            die(f"{what}: {quote(text)}")
        base, used = 1024, 1
        if unit != "b":
            if rest[1:3] == "iB":
                used = 3
            elif rest[1:2] in ("B", "D"):
                base, used = 1000, 2
        value *= 512 if unit == "b" else base ** POWERS[unit]
        if rest[used:]:
            die(f"{what}: {quote(text)}")
    if value > UINTMAX:
        die(f"{what}: {quote(text)}: Value too large for defined data type")
    return value


def set_count(opts, value, lines):
    opts.lines = lines
    # As GNU's: a `+` makes it count from the start, and a later count without
    # one does not undo that.
    if value.startswith("+"):
        opts.from_start = True
    elif value.startswith("-"):
        value = value[1:]
    opts.count = count_of(value, "invalid number of lines" if lines else "invalid number of bytes")


def obsolete(argv, opts):
    """
    The legacy form — `-5`, `+5`, `-5c`, `-l` — which GNU reads only as the
    first argument and with at most one file after it: `tail -2 a b` is an
    error there, "option used in invalid context". True if it was one.
    """
    if not (len(argv) == 1 or (len(argv) == 2 and not (argv[1][:1] == "-" and argv[1][1:]))
            or (len(argv) in (2, 3) and argv[1] == "--")):
        return False
    arg = argv[0]
    if arg[:1] == "+":
        from_start = True
    elif arg[:1] == "-":
        # A bare `-` is standard input, and `-c` wants its count.
        if not arg[2 if arg[1:2] == "c" else 1:][:1]:
            return False
        from_start = False
    else:
        return False
    m = re.match(r"([0-9]*)([bcl]?)(f?)$", arg[1:])
    if not m:
        return False
    digits, unit, follow = m.groups()
    if follow:
        die(FOLLOW)
    count = int(digits) if digits else 10
    if unit == "b":
        count *= 512
    if count > UINTMAX:
        die(f"invalid number: {quote(arg)}: Numerical result out of range")
    opts.from_start, opts.lines, opts.count = from_start, unit not in ("b", "c"), count
    return True


def resolve(word):
    if word in LONG:
        return word
    found = [name for name in LONG if name.startswith(word)]
    if len(found) > 1:
        die(f"option '--{word}' is ambiguous; possibilities: " + " ".join(f"'--{n}'" for n in found))
    return found[0] if found else None


def apply(opts, flag, value, notes):
    if flag in ("n", "c"):
        set_count(opts, value, flag == "n")
    elif flag == "q":
        opts.headers = False
    elif flag == "v":
        opts.headers = True
    elif flag == "z":
        opts.zero = True
    elif flag == "s":
        # Only how often -f looks, so nothing without it; GNU checks it all the same.
        if not re.fullmatch(r"[ \t\n\v\f\r]*\+?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", value):
            die(f"invalid number of seconds: {quote(value)}")
    elif flag == "max-unchanged-stats":
        if not re.fullmatch(r"[0-9]+", value):
            die(f"invalid maximum number of unchanged stats between opens: {quote(value)}")
    elif flag == "pid":
        if not re.fullmatch(r"[0-9]+", value):
            die(f"invalid PID: {quote(value)}")
        notes["pid"] = "warning: PID ignored; --pid=PID is useful only when following"
    elif flag == "retry":
        notes["retry"] = "warning: --retry ignored; --retry is useful only when following"
    elif flag == "help":
        sys.stdout.write(
            "Usage: tail [OPTION]... [FILE]...\n"
            "The pad's tail: GNU tail 9.4, without following, for these options:\n"
            f"  {SUPPORTED}\n"
        )
        raise SystemExit(0)


def parse(argv):
    opts = Options()
    if argv and obsolete(argv, opts):
        argv = argv[1:]
    files = []
    notes = {}
    i = 0
    only_files = False
    while i < len(argv):
        arg = argv[i]
        if only_files or arg == "-" or not arg.startswith("-"):
            files.append(arg)
        elif arg == "--":
            only_files = True
        elif arg.startswith("--"):
            word, eq, inline = arg[2:].partition("=")
            name = resolve(word)
            if name is None:
                die(f"unsupported option '{arg}'. This shim supports: {SUPPORTED}")
            takes, flag = LONG[name]
            if name == "follow":
                die(FOLLOW)
            if flag is None:
                die(f"unsupported option '--{name}'. This shim supports: {SUPPORTED}")
            if takes is False and eq:
                die(f"option '--{name}' doesn't allow an argument")
            value = None
            if takes is True:
                if eq:
                    value = inline
                elif i + 1 < len(argv):
                    i += 1
                    value = argv[i]
                else:
                    die(f"option '--{name}' requires an argument")
            apply(opts, flag, value, notes)
        else:
            rest = arg[1:]
            while rest:
                flag, rest = rest[0], rest[1:]
                if flag in "ncs":
                    if rest:
                        value, rest = rest, ""
                    elif i + 1 < len(argv):
                        i += 1
                        value = argv[i]
                    else:
                        die(f"option requires an argument -- '{flag}'")
                    apply(opts, flag, value, notes)
                elif flag in "qvz":
                    apply(opts, flag, None, notes)
                elif flag in "fF":
                    die(FOLLOW)
                elif flag.isdigit():
                    die(f"option used in invalid context -- {flag}")
                else:
                    die(f"unsupported option '-{flag}'. This shim supports: {SUPPORTED}")
        i += 1
    for note in notes.values():
        warn(note)
    return opts, files


# ------------------------------------------------------------------ output


def copy(handle, out):
    while True:
        block = handle.read(BLOCK)
        if not block:
            return
        out.write(block)


def regular(handle):
    """Where a regular file's unread part starts and ends, or None for a pipe."""
    try:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            return None
        start = handle.tell()
        end = handle.seek(0, os.SEEK_END)
        handle.seek(start)
    except (OSError, ValueError):
        return None
    # A file that says it is empty may only not know its size, as /proc's do.
    return (start, end) if end > start else None


def from_start(handle, opts, sep, out):
    """`+N`: everything from line or byte N on, read once, front to back."""
    skip = max(opts.count - 1, 0)
    if not opts.lines:
        span = regular(handle)
        if span:
            handle.seek(min(span[0] + skip, span[1]))
        else:
            while skip:
                block = handle.read(min(skip, BLOCK))
                if not block:
                    return
                skip -= len(block)
        copy(handle, out)
        return
    while skip:
        block = handle.read(BLOCK)
        if not block:
            return
        seen = block.count(sep)
        if seen < skip:
            skip -= seen
            continue
        at = 0
        for _ in range(skip):
            at = block.find(sep, at) + 1
        out.write(memoryview(block)[at:])
        break
    copy(handle, out)


def last_of(data, count, sep):
    """Where the last `count` lines of `data` start; a final line without its newline still counts."""
    want = count + 1 if data.endswith(sep) else count
    at = len(data)
    for _ in range(want):
        at = data.rfind(sep, 0, at)
        if at < 0:
            return 0
    return at + 1


def from_end(handle, opts, sep, out):
    """The last N lines or bytes."""
    count = opts.count
    if not count:
        return
    span = regular(handle)
    if span:
        # A file: read back from its end only as far as it takes, then copy
        # forward from there — not the whole of a 90 MB log for its last lines.
        start, end = span
        if not opts.lines:
            handle.seek(max(start, end - count))
            copy(handle, out)
            return
        handle.seek(end - 1)
        want = count + 1 if handle.read(1) == sep else count
        at = end
        while at > start:
            size = min(BLOCK, at - start)
            at -= size
            handle.seek(at)
            block = handle.read(size)
            seen = block.count(sep)
            if seen >= want:
                cut = len(block)
                for _ in range(want):
                    cut = block.rfind(sep, 0, cut)
                handle.seek(at + cut + 1)
                copy(handle, out)
                return
            want -= seen
        handle.seek(start)
        copy(handle, out)
        return
    # A pipe: keep only the blocks the last N lines or bytes could be in.
    blocks, sizes = deque(), deque()
    total = 0
    need = count + 1
    while True:
        block = handle.read(BLOCK)
        if not block:
            break
        size = block.count(sep) if opts.lines else len(block)
        blocks.append(block)
        sizes.append(size)
        total += size
        while len(blocks) > 1 and total - sizes[0] >= need:
            total -= sizes.popleft()
            blocks.popleft()
    data = b"".join(blocks)
    at = last_of(data, count, sep) if opts.lines else max(0, len(data) - count)
    out.write(memoryview(data)[at:])


def main(argv):
    opts, files = parse(argv)
    files = files or ["-"]
    show = opts.headers if opts.headers is not None else len(files) > 1
    sep = b"\0" if opts.zero else b"\n"
    out = sys.stdout.buffer
    status = 0
    first = True
    for name in files:
        shown = "standard input" if name == "-" else name
        handle = None
        if name == "-":
            handle = sys.stdin.buffer
        else:
            try:
                handle = open(name, "rb")
            except IsADirectoryError:
                pass    # GNU opens it, says its header, and fails to read it
            except OSError as e:
                warn(f"cannot open {quote(name)} for reading: {e.strerror}")
                status = 1
                continue
        if show:
            # A blank line between files, not before the first one shown:
            # a missing first file left one at the top.
            out.write(b"%s==> %s <==\n" % (b"" if first else b"\n", os.fsencode(shown)))
            first = False
        if handle is None:
            warn(f"error reading {quote(shown)}: Is a directory")
            status = 1
            continue
        try:
            (from_start if opts.from_start else from_end)(handle, opts, sep, out)
        except BrokenPipeError:
            raise
        except OSError as e:
            warn(f"error reading {quote(shown)}: {e.strerror}")
            status = 1
        finally:
            if name != "-":
                handle.close()
    return status


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
