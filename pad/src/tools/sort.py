"""sort, because the shipped coreutils does not have one.

`sharrattj/coreutils` is uutils 0.0.7 built as a multi-call binary, and `sort`
is not among the functions compiled into it — `sort file` answers
"file: function/utility not found", and so does `sort sort file`. The newer
`wasmer/coreutils@1.0.25` is the same build. The package that would fix it
properly, `kilyanni/coreutils` (GNU 9.11), cannot be installed from here.

So this stands in, the way `awk.py` does, and for everything it accepts it is
GNU sort 9.4 in the C locale — the only locale this sandbox has: lines are
bytes and compared as bytes, every -k key counts, in order, with its own
modifiers, and lines equal by every key fall back to comparing whole lines.
That was not always so. Until 20 October only the last -k was used, a key's
own `n` was a traceback, -f lower-cased where GNU upper-cases, -u kept the
smallest of equal lines rather than the first, and a file's CRs were dropped.

What it does not do — --debug, --files0-from, --random-source — is refused
rather than quietly ignored, because a sort that silently drops an option is
worse than one that admits it cannot. -S, -T, --parallel, --batch-size and
--compress-program are accepted: they tune GNU's memory, temporary files and
threads, and change nothing about what comes out.
"""

import os
import re
import sys
from decimal import Decimal
from operator import itemgetter

SUPPORTED = (
    "-b -d -f -g -h -i -M -n -R -r -V --sort=WORD -k KEYDEF -t SEP -s -u -z "
    "-c -C -m -o FILE, and -S -T --parallel --batch-size --compress-program, which change nothing here"
)

# What GNU sort treats as blank: space and tab, and newline, which only a
# line can contain under -z.
BLANKS = b" \t\n"
BLANK_RUN = re.compile(rb"[ \t\n]*")
UPPER = bytes.maketrans(b"abcdefghijklmnopqrstuvwxyz", b"ABCDEFGHIJKLMNOPQRSTUVWXYZ")
ALNUM = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
IGNORED = {
    # -d: everything but letters, digits and blanks. -i: the unprintable.
    "d": bytes(c for c in range(256) if c not in ALNUM and c not in BLANKS),
    "i": bytes(c for c in range(256) if not 0x20 <= c <= 0x7E),
}


def die(message, code=2):
    sys.stderr.write(f"sort: {message}\n")
    raise SystemExit(code)


# Every long option GNU sort 9.4 has, so that an abbreviation resolves, or is
# ambiguous, exactly as it would there. A name of None is refused here.
LONG = {
    "batch-size": (True, "batch-size"),
    "buffer-size": (True, "S"),
    "check": ("optional", "check"),
    "compress-program": (True, "compress-program"),
    "debug": (False, None),
    "dictionary-order": (False, "d"),
    "field-separator": (True, "t"),
    "files0-from": (True, None),
    "general-numeric-sort": (False, "g"),
    "help": (False, "help"),
    "human-numeric-sort": (False, "h"),
    "ignore-case": (False, "f"),
    "ignore-leading-blanks": (False, "b"),
    "ignore-nonprinting": (False, "i"),
    "key": (True, "k"),
    "merge": (False, "m"),
    "month-sort": (False, "M"),
    "numeric-sort": (False, "n"),
    "output": (True, "o"),
    "parallel": (True, "parallel"),
    "random-sort": (False, "R"),
    "random-source": (True, None),
    "reverse": (False, "r"),
    "sort": (True, "sort"),
    "stable": (False, "s"),
    "temporary-directory": (True, "T"),
    "unique": (False, "u"),
    "version": (False, None),
    "version-sort": (False, "V"),
    "zero-terminated": (False, "z"),
}
FLAGS = set("bcCdfghimMnrRsuVz")
VALUED = set("koStT")
SORT_WORDS = {"general-numeric": "g", "human-numeric": "h", "month": "M", "numeric": "n", "random": "R", "version": "V"}
CHECK_WORDS = {"diagnose-first": "c", "quiet": "C", "silent": "C"}


def resolve(word, choices, ambiguous):
    """An exact name, or the one name `word` abbreviates, as getopt and argmatch allow."""
    if word in choices:
        return word
    found = [name for name in choices if name.startswith(word)]
    if len(found) == 1:
        return found[0]
    if found:
        die(ambiguous(found))
    return None


class Key:
    """One -k key, or the whole line under the global options: GNU's keyfield."""

    def __init__(self):
        self.sword = 0          # fields skipped before the key starts
        self.schar = 0          # then characters skipped
        self.eword = None       # None: the key runs to the end of the line
        self.echar = 0          # 0: to the end of field eword + 1
        self.skipsblanks = False
        self.skipeblanks = False
        self.fold = False
        self.ignore = None      # "d" or "i"
        self.kinds = set()      # of "nghMRV"
        self.reverse = False

    def plain(self):
        return not (self.ignore or self.fold or self.skipsblanks or self.skipeblanks or self.kinds)


def set_ordering(spec, key, blanks):
    """Ordering letters at the start of `spec`, set on `key`; the rest is returned."""
    i = 0
    while i < len(spec):
        c = spec[i]
        if c == "b":
            if blanks != "end":
                key.skipsblanks = True
            if blanks != "start":
                key.skipeblanks = True
        elif c == "d":
            key.ignore = "d"
        elif c == "i":
            # As GNU: -d wins over -i whichever comes first.
            if not key.ignore:
                key.ignore = "i"
        elif c == "f":
            key.fold = True
        elif c == "r":
            key.reverse = True
        elif c in "ghMnRV":
            key.kinds.add(c)
        else:
            break
        i += 1
    return spec[i:]


def field_count(text, what, spec):
    m = re.match(r"[ \t\n\v\f\r]*\+?([0-9]+)", text)
    if not m:
        die(f"{what}: invalid count at start of '{text}'")
    return int(m.group(1)), text[m.end():]


def parse_key(spec):
    key = Key()
    n, rest = field_count(spec, "invalid number at field start", spec)
    if n == 0:
        die(f"field number is zero: invalid field specification '{spec}'")
    key.sword = n - 1
    if rest.startswith("."):
        n, rest = field_count(rest[1:], "invalid number after '.'", spec)
        if n == 0:
            die(f"character offset is zero: invalid field specification '{spec}'")
        key.schar = n - 1
    rest = set_ordering(rest, key, "start")
    if rest.startswith(","):
        n, rest = field_count(rest[1:], "invalid number after ','", spec)
        if n == 0:
            die(f"field number is zero: invalid field specification '{spec}'")
        key.eword = n - 1
        if rest.startswith("."):
            key.echar, rest = field_count(rest[1:], "invalid number after '.'", spec)
        rest = set_ordering(rest, key, "end")
    if rest:
        die(f"stray character in field spec: invalid field specification '{spec}'")
    return key


class Options:
    def __init__(self):
        self.whole = Key()      # the global ordering options
        self.keys = []
        self.tab = None
        self.out = None
        self.check = None       # "c" says where, "C" only exits 1
        self.merge = False
        self.stable = False
        self.unique = False
        self.zero = False


def apply(opts, name, value):
    if name in "bdfghiMnRrV" and len(name) == 1:
        set_ordering(name, opts.whole, "both")
    elif name in ("c", "C", "check"):
        mode = name
        if name == "check":
            mode = "c"
            if value is not None:
                word = resolve(value, CHECK_WORDS, lambda _: f"ambiguous argument '{value}' for '--check'")
                if word is None:
                    sys.stderr.write(
                        f"sort: invalid argument '{value}' for '--check'\nValid arguments are:\n"
                        "  - 'quiet', 'silent'\n  - 'diagnose-first'\n"
                    )
                    raise SystemExit(1)
                mode = CHECK_WORDS[word]
        if opts.check and opts.check != mode:
            die("options '-cC' are incompatible")
        opts.check = mode
    elif name == "m":
        opts.merge = True
    elif name == "s":
        opts.stable = True
    elif name == "u":
        opts.unique = True
    elif name == "z":
        opts.zero = True
    elif name == "k":
        opts.keys.append(parse_key(value))
    elif name == "t":
        tab = b"\0" if value == "\\0" else os.fsencode(value)
        if not tab:
            die("empty tab")
        if len(tab) > 1:
            die(f"multi-character tab '{value}'")
        if opts.tab is not None and opts.tab != tab:
            die("incompatible tabs")
        opts.tab = tab
    elif name == "o":
        if opts.out is not None and opts.out != value:
            die("multiple output files specified")
        opts.out = value
    elif name == "sort":
        word = resolve(value, SORT_WORDS, lambda _: f"ambiguous argument '{value}' for '--sort'")
        if word is None:
            sys.stderr.write(
                f"sort: invalid argument '{value}' for '--sort'\nValid arguments are:\n"
                + "".join(f"  - '{w}'\n" for w in SORT_WORDS)
            )
            raise SystemExit(1)
        set_ordering(SORT_WORDS[word], opts.whole, "both")
    elif name == "S":
        if not re.fullmatch(r"[0-9]+[%bkKmMgGtTpPeEzZyYrRqQ]?", value):
            die(f"invalid -S argument '{value}'")
    elif name == "parallel":
        if not re.fullmatch(r"[0-9]+", value):
            die(f"invalid --parallel argument '{value}'")
        if int(value) == 0:
            die("number in parallel must be nonzero")
    elif name == "batch-size":
        if not re.fullmatch(r"[0-9]+", value) or int(value) < 2:
            die(f"invalid --batch-size argument '{value}'\nsort: minimum --batch-size argument is '2'")
    elif name == "help":
        sys.stdout.write(
            "Usage: sort [OPTION]... [FILE]...\n"
            "The pad's sort: GNU sort 9.4 in the C locale, for these options:\n"
            f"  {SUPPORTED}\n"
        )
        raise SystemExit(0)
    # -T and --compress-program: GNU only uses them once input outgrows memory.


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
            word, eq, inline = arg[2:].partition("=")
            name = resolve(word, LONG, lambda found: f"option '--{word}' is ambiguous; possibilities: "
                           + " ".join(f"'--{n}'" for n in found))
            if name is None:
                die(f"unsupported option '{arg}'. This shim supports: {SUPPORTED}")
            takes, action = LONG[name]
            if action is None:
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
            elif takes == "optional" and eq:
                value = inline
            apply(opts, action, value)
        else:
            rest = arg[1:]
            while rest:
                flag, rest = rest[0], rest[1:]
                if flag in FLAGS:
                    apply(opts, flag, None)
                elif flag in VALUED:
                    if rest:
                        value, rest = rest, ""
                    elif i + 1 < len(argv):
                        i += 1
                        value = argv[i]
                    else:
                        die(f"option requires an argument -- '{flag}'")
                    apply(opts, flag, value)
                else:
                    die(f"unsupported option '-{flag}'. This shim supports: {SUPPORTED}")
        i += 1
    return opts, files


def settle_keys(opts):
    """
    GNU's rules for which options a key has: one with no ordering options of
    its own — not even `b` or `r` — takes all the global ones; one with any
    keeps only its own. With no -k, the global options, if any, make one key of
    the whole line.
    """
    g = opts.whole
    keys = opts.keys
    for key in keys:
        if key.plain() and not key.reverse:
            key.ignore, key.fold, key.kinds = g.ignore, g.fold, set(g.kinds)
            key.skipsblanks, key.skipeblanks, key.reverse = g.skipsblanks, g.skipeblanks, g.reverse
    if not keys and not g.plain():
        keys = [g]
    for key in keys:
        if sum((c in key.kinds) for c in "nghM") + bool(key.kinds & set("RV") or key.ignore) > 1:
            letters = ("d" if key.ignore == "d" else "") + ("f" if key.fold else "")
            letters += "".join(c for c in "gh" if c in key.kinds) + ("i" if key.ignore == "i" else "")
            letters += "".join(c for c in "MnRV" if c in key.kinds)
            die(f"options '-{letters}' are incompatible")
    return keys


# ------------------------------------------------------------------ fields

REPEAT_LIMIT = 4096


def skipper(unit, count):
    """Where `count` repetitions of the regex `unit` end, from the start of a line."""
    if count <= REPEAT_LIMIT:
        whole = re.compile(b"(?:%s){%d}" % (unit, count))
        return lambda line: whole.match(line).end()
    # Python's regex steps through every repetition, even the empty ones past
    # the end of a short line: `-k10000000` took seconds a line. Each one that
    # is not at the end moves on by at least a character, so no line needs
    # more than its own length of them.
    one = re.compile(unit)

    def far(line):
        p, end = 0, len(line)
        for _ in range(min(count, end)):
            p = one.match(line, p).end()
            if p == end:
                break
        return p

    return far


def field_of(key, tab):
    """
    The part of a line a key compares, found as GNU's begfield and limfield
    find it. Without -t a field is its leading blanks and the word after them;
    with -t it is what lies between separators. A key with no end runs to the
    end of the line — `-k2` stopped at field 2, so lines equal there kept their
    order whatever followed (audit R3).
    """
    if tab is None:
        unit = rb"[ \t\n]*[^ \t\n]*"
    else:
        t = b"\\x%02x" % tab[0]
        unit = b"[^%s]*%s?" % (t, t)
    if key.sword == 0 and key.schar == 0 and key.eword is None:
        return (lambda line: line.lstrip(BLANKS)) if key.skipsblanks else None

    begin_fields = skipper(unit, key.sword) if key.sword else None
    skipsblanks, schar = key.skipsblanks, key.schar

    def begin(line):
        p = begin_fields(line) if begin_fields else 0
        if skipsblanks:
            p = BLANK_RUN.match(line, p).end()
        return p + schar

    if key.eword is None:
        return lambda line: line[begin(line):]

    echar, skipeblanks = key.echar, key.skipeblanks
    if echar:
        end_fields = skipper(unit, key.eword) if key.eword else (lambda line: 0)
    elif tab is None:
        end_fields = skipper(unit, key.eword + 1)
    else:
        # Up to the separator that ends field eword + 1, not past it.
        t = b"\\x%02x" % tab[0]
        rest = re.compile(b"[^%s]*" % t)
        before = skipper(unit, key.eword) if key.eword else (lambda line: 0)
        end_fields = lambda line: rest.match(line, before(line)).end()

    def end(line):
        p = end_fields(line)
        if echar:
            if skipeblanks:
                p = BLANK_RUN.match(line, p).end()
            p += echar
        return p

    # A key that ends before it starts is empty, as GNU treats it.
    return lambda line: line[begin(line):end(line)]


# ------------------------------------------------------------------ orders

NUMBER = re.compile(rb"[ \t\n]*(-?)([0-9]*)(?:\.([0-9]*))?")


def numeric(text):
    """
    -n: the leading number, and 0 for a key with none — so `word` sorts
    between -1 and 2. Exact, not a float: 9007199254740993 and
    9007199254740992 were equal as floats and kept their order (audit R3).
    """
    sign, whole, fraction = NUMBER.match(text).groups()
    if fraction:
        fraction = fraction.rstrip(b"0")
    if fraction:
        value = Decimal((b"%s.%s" % (whole or b"0", fraction)).decode())
    elif whole:
        value = int(whole) if len(whole) < 4000 else Decimal(whole.decode())
    else:
        return 0
    return -value if sign else value


UNITS = {ord(c): n for n, c in enumerate("KMGTPEZYRQ", 1)}
UNITS[ord("k")] = 1
HUMAN = re.compile(rb"[ \t\n]*(-?)([0-9]*(?:\.[0-9]*)*)(.?)", re.S)


def human(text):
    """-h: a number's SI or IEC unit first (none < K < M < ... < Q), then the number."""
    m = HUMAN.match(text)
    order = UNITS.get(m.group(3)[0], 0) if m.group(3) else 0
    if not m.group(2).strip(b"0."):
        order = 0           # 0K, like 0, has no magnitude
    return (-order if m.group(1) else order, numeric(text))


GENERAL = re.compile(
    rb"[ \t\n\v\f\r]*([+-]?)(?:"
    rb"(0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?)"
    rb"|((?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)"
    rb"|(?i:(inf(?:inity)?)|(nan(?:\([0-9A-Za-z_]*\))?)))"
)
# A long double's reach: past it strtold says inf, below it 0.
HUGE = Decimal("1.18973149535723176508575932662800702e4932")
TINY = Decimal("3.2e-4966")
INF = Decimal("Infinity")


def general(text):
    """
    -g: what strtold reads. A key that is no number sorts first, then NaN,
    -nan before nan, then the numbers from -inf to inf. Compared exactly where
    GNU compares long doubles; the two part only past 33 significant digits.
    """
    m = GENERAL.match(text)
    if not m:
        return (0,)
    sign, hexa, decimal, inf, nan = m.groups()
    if nan is not None:
        return (1, sign != b"-")
    if inf is not None:
        value = INF
    else:
        try:
            value = Decimal(decimal.decode()) if decimal is not None else Decimal(float.fromhex(hexa.decode()))
        except (ArithmeticError, ValueError):
            value = INF if b"-" not in (decimal or b"")[1:] else Decimal(0)
        size = value.copy_abs()
        if size > HUGE:
            value = INF
        elif size < TINY:
            value = Decimal(0)
    return (2, -value if sign == b"-" else value)


MONTHS = {m.encode(): n for n, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(), 1)}


def month(text):
    """-M: JAN to DEC by their first three letters, any case; anything else is 0, first."""
    return MONTHS.get(text.lstrip(BLANKS)[:3].upper(), 0)


# -V, as gnulib's filevercmp: runs of non-digits compared a byte at a time —
# `~` before the end, the end before letters, letters before everything else —
# and runs of digits compared as numbers. Each run of non-digits is turned into
# bytes that order the same way, ending in 2, the rank of its end.
VRANK = bytearray(256)
VRANK[ord("~")] = 1
_rank = 3
for _c in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz":
    VRANK[_c] = _rank
    _rank += 1
for _c in range(256):
    if _c not in ALNUM and _c != ord("~"):
        VRANK[_c] = _rank
        _rank += 1
VRANK = bytes(VRANK)
DIGITS = re.compile(rb"([0-9]+)")
SUFFIX_GROUPS = re.compile(rb"(?:\.[A-Za-z~][A-Za-z0-9~]*)*")
ZERO = (0, b"")


def version_parts(text):
    parts = DIGITS.split(text)
    key = []
    for i in range(0, len(parts), 2):
        key.append(parts[i].translate(VRANK) + b"\x02")
        digits = parts[i + 1].lstrip(b"0") if i + 1 < len(parts) else b""
        key.append((len(digits), digits))
    # Trailing empty runs and zeros are nothing: `a`, `a0` and `a00` are equal.
    while len(key) > 1 and key[-2] == b"\x02" and key[-1] == ZERO:
        del key[-2:]
    key.append(b"\x02")
    return tuple(key)


def prefix_length(text):
    """Where a name's suffix starts: the longest run of `.ext` parts at its end, not at its start."""
    n = len(text)
    i = 0
    while True:
        dot = text.find(b".", i + 1)
        if dot < 0:
            return n
        after = SUFFIX_GROUPS.match(text, dot).end()
        if after == n:
            return dot
        i = after if after > dot else dot


def version(text):
    if not text:
        return (0,)
    if text[:1] == b".":
        if text == b".":
            return (1,)
        if text == b"..":
            return (2,)
        rank = 3
    else:
        rank = 4
    whole = version_parts(text)
    cut = prefix_length(text)
    return (rank, whole if cut == len(text) else version_parts(text[:cut]), whole)


def random_order():
    """-R: lines in an order of their key's hash, so equal keys still come together."""
    import hashlib

    salt = os.urandom(16)
    return lambda text: (hashlib.md5(salt + text).digest(), text)


def value_of(key, tab):
    """A function from a line to what this key compares, in Python's order."""
    steps = [field_of(key, tab)]
    if key.fold or key.ignore:
        table, delete = UPPER if key.fold else None, IGNORED.get(key.ignore, b"")
        steps.append(lambda text: text.translate(table, delete))
    # As GNU's keycompare picks, when a key has more than one.
    for kind, how in (("n", numeric), ("g", general), ("h", human), ("M", month), ("R", None), ("V", version)):
        if kind in key.kinds:
            steps.append(how or random_order())
            break
    steps = [s for s in steps if s]
    if not steps:
        return lambda line: line
    if len(steps) == 1:
        return steps[0]
    if len(steps) == 2:
        first, second = steps
        return lambda line: second(first(line))
    first, second, third = steps
    return lambda line: third(second(first(line)))


# ------------------------------------------------------------------ sorting


class Order:
    """How records compare: each key in turn, then the whole line unless -s or -u."""

    def __init__(self, keys, opts):
        self.values = [value_of(k, opts.tab) for k in keys]
        self.width = len(keys) or 1
        # With no key at all the whole line is the key, -s and -u or not.
        self.last_resort = not keys or not (opts.stable or opts.unique)
        self.directions = [k.reverse for k in keys] + ([opts.whole.reverse] if self.last_resort else [])

    def records(self, lines):
        """Each line as (value of key 1, ..., line)."""
        if not self.values:
            return [(line,) for line in lines]
        return list(zip(*[list(map(v, lines)) for v in self.values], lines))

    def compare(self, a, b):
        for i, backwards in enumerate(self.directions):
            x, y = a[i], b[i]
            if x != y:
                less = x < y
                return (1 if less else -1) if backwards else (-1 if less else 1)
        return 0

    def sort(self, records):
        # One stable sort per run of keys that go the same way, least
        # significant first: a key that is reversed and one that is not
        # cannot share a sort, and a comparison function called a million
        # times is what a slow sandbox cannot afford.
        groups = []
        for i, backwards in enumerate(self.directions):
            if groups and groups[-1][1] == backwards:
                groups[-1][0].append(i)
            else:
                groups.append(([i], backwards))
        if len(groups) == 1 and self.last_resort:
            # Every key and then the line, all one way: the records as they are.
            records.sort(reverse=groups[0][1])
        else:
            for indices, backwards in reversed(groups):
                records.sort(key=itemgetter(*indices), reverse=backwards)

    def unique(self, records):
        """The first of each run of records equal by every key — GNU keeps the first, not the smallest."""
        kept = []
        width = self.width
        last = None
        for r in records:
            k = r[:width]
            if not kept or k != last:
                kept.append(r)
                last = k
        return kept


def read_lines(name, terminator):
    """
    One input's lines, as bytes: a CR is part of its line, as in GNU, where
    universal newlines dropped it from a file and kept it from a pipe. A file
    that does not end in a newline still ends its last line: read as one text,
    `z` with no newline and then `a` were one line, `za` (audit R3).
    """
    try:
        if name == "-":
            data = sys.stdin.buffer.read()
        else:
            with open(name, "rb") as handle:
                data = handle.read()
    except OSError as e:
        die(f"read failed: {name}: {e.strerror}")
    lines = data.split(terminator)
    if lines[-1] == b"":
        lines.pop()
    return lines


def main(argv):
    opts, files = parse(argv)
    keys = settle_keys(opts)
    terminator = b"\0" if opts.zero else b"\n"
    files = files or ["-"]
    if opts.check:
        if opts.out is not None:
            die(f"options '-{opts.check}o' are incompatible")
        if len(files) > 1:
            die(f"extra operand '{files[1]}' not allowed with -{opts.check}")

    # As GNU: every input readable, and the output openable, before any is read.
    for name in files:
        if name != "-":
            try:
                open(name, "rb").close()
            except IsADirectoryError:
                pass        # readable as GNU asks; reading it is what fails
            except OSError as e:
                die(f"cannot read: {name}: {e.strerror}")
    if opts.out is not None:
        try:
            os.close(os.open(opts.out, os.O_WRONLY | os.O_CREAT, 0o666))
        except OSError as e:
            die(f"open failed: {opts.out}: {e.strerror}")

    inputs = [read_lines(name, terminator) for name in files]
    order = Order(keys, opts)

    if opts.check:
        records = order.records(inputs[0])
        for n in range(1, len(records)):
            c = order.compare(records[n - 1], records[n])
            if c > 0 or (c == 0 and opts.unique):
                if opts.check == "c":
                    sys.stderr.flush()
                    sys.stderr.buffer.write(
                        b"sort: %s:%d: disorder: %s\n" % (os.fsencode(files[0]), n + 1, records[n][-1])
                    )
                return 1
        return 0

    if opts.merge:
        import heapq
        from functools import cmp_to_key

        records = list(heapq.merge(*map(order.records, inputs), key=cmp_to_key(order.compare)))
    elif not keys:
        # The common case, and the cheapest: whole lines as bytes.
        lines = [line for chunk in inputs for line in chunk]
        lines.sort(reverse=opts.whole.reverse)
        records = None
        if opts.unique:
            lines = [line for i, line in enumerate(lines) if not i or line != lines[i - 1]]
    else:
        records = order.records([line for chunk in inputs for line in chunk])
        order.sort(records)
    if records is not None:
        if opts.unique:
            records = order.unique(records)
        lines = [r[-1] for r in records]

    body = terminator.join(lines) + terminator if lines else b""
    if opts.out is not None:
        try:
            with open(opts.out, "wb") as handle:
                handle.write(body)
        except OSError as e:
            die(f"open failed: {opts.out}: {e.strerror}")
    else:
        sys.stdout.buffer.write(body)
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
