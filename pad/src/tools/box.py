"""The small commands the shipped coreutils does not have, in one file.

One file rather than one per command: each is short, and the shell writes and
aliases these at startup, so nine files would be nine round trips before the
first prompt. Dispatch is on argv[1], which is the same multi-call shape the
coreutils binary uses — and, unlike that one, everything listed here is
actually present.

Each command is checked against the real tool before being trusted. They
refuse what they do not implement rather than ignoring it: a `diff` that
silently drops -u is worse than one that says it cannot.
"""

import hashlib
import os
import stat
import subprocess
import sys
import zipfile


def die(tool, message, code=2):
    sys.stderr.write(f"{tool}: {message}\n")
    raise SystemExit(code)


def read_text(name, tool):
    if name == "-":
        return sys.stdin.read()
    try:
        with open(name, "r", errors="surrogateescape") as f:
            return f.read()
    except OSError as e:
        die(tool, f"{name}: {e.strerror}")


# ---------------------------------------------------------------- diff
def cmd_diff(argv):
    import difflib

    unified, brief, ignore_case, context = True, False, False, 3
    files = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-u", "--unified"):
            unified = True
        elif a in ("-q", "--brief"):
            brief = True
        elif a in ("-i", "--ignore-case"):
            ignore_case = True
        elif a.startswith("-U"):
            context = int(a[2:] or argv[(i := i + 1)])
        elif a == "--":
            files.extend(argv[i + 1 :])
            break
        elif a.startswith("-") and a != "-":
            die("diff", f"unsupported option '{a}'. Supported: -u -q -i -U N")
        else:
            files.append(a)
        i += 1
    if len(files) != 2:
        die("diff", "needs exactly two files")

    left, right = (read_text(f, "diff") for f in files)
    if ignore_case:
        left, right = left.lower(), right.lower()
    if left == right:
        return 0
    if brief:
        print(f"Files {files[0]} and {files[1]} differ")
        return 1
    out = difflib.unified_diff(
        left.splitlines(keepends=True),
        right.splitlines(keepends=True),
        fromfile=files[0],
        tofile=files[1],
        n=context,
    )
    sys.stdout.writelines(out)
    return 1


# ---------------------------------------------------------------- tree
def cmd_tree(argv):
    """tree 2.1: -a, -d, -L, -I, --dirsfirst and --noreport, drawn and counted as tree 2.1 does.

    tree 2.x counts the directory it was asked to list — when it lists
    anything in it — and a symlink to a directory as a directory, without
    following it. Lines are drawn in UTF-8 unless the locale says otherwise
    (tree_utf8), and an unprintable name is escaped the way tree escapes it.
    """
    import fnmatch

    show_all = dirs_only = dirs_first = noreport = False
    level, ignore, roots, i = None, [], [], 0
    supported = "Supported: -a -d -L LEVEL -I PATTERN --dirsfirst --noreport"
    while i < len(argv):
        a = argv[i]
        if a == "--":
            roots.extend(argv[i + 1 :])
            break
        if a in ("--dirsfirst", "--noreport"):
            dirs_first, noreport = dirs_first or a == "--dirsfirst", noreport or a == "--noreport"
        elif a.startswith("--"):
            die("tree", f"unsupported option '{a}'. {supported}")
        elif a.startswith("-") and a != "-":
            for f in a[1:]:
                if f == "a":
                    show_all = True
                elif f == "d":
                    dirs_only = True
                elif f in "LI":
                    # tree takes an option's argument from the next word, never the same one.
                    i += 1
                    value = argv[i] if i < len(argv) else ""
                    if f == "L":
                        if not value.isdigit() or int(value) < 1:
                            sys.stderr.write("tree: Invalid level, must be greater than 0.\n")
                            return 1
                        level = int(value)
                    else:
                        ignore.extend(value.split("|"))
                else:
                    die("tree", f"unsupported option '-{f}'. {supported}")
        else:
            roots.append(a)
        i += 1

    utf8 = tree_utf8()
    tee, elbow, pipe, gap = ("├── ", "└── ", "│   ", "    ") if utf8 else ("|-- ", "`-- ", "|   ", "    ")
    files = dirs = 0

    def listing(path):
        names = os.listdir(path)
        if not show_all:
            names = [n for n in names if not n.startswith(".")]
        if ignore:
            names = [n for n in names if not any(fnmatch.fnmatchcase(n, p) for p in ignore)]
        entries = []
        for n in sorted(names, key=os.fsencode):
            full = os.path.join(path, n)
            entries.append((n, full, os.path.islink(full), os.path.isdir(full)))
        if dirs_only:
            entries = [e for e in entries if e[3]]
        if dirs_first:
            entries.sort(key=lambda e: not e[3])
        return entries

    out = []

    def walk(entries, prefix, depth):
        nonlocal files, dirs
        for index, (name, full, is_link, is_dir) in enumerate(entries):
            last = index == len(entries) - 1
            line = prefix + (elbow if last else tee) + tree_name(name, utf8)
            if is_dir:
                dirs += 1
            else:
                files += 1
            if is_link:
                out.append(f"{line} -> {tree_name(os.readlink(full), utf8)}")
                continue
            if not is_dir or (level is not None and depth >= level):
                out.append(line)
                continue
            try:
                inner = listing(full)
            except OSError:
                out.append(line + "  [error opening dir]")
                continue
            out.append(line)
            walk(inner, prefix + (gap if last else pipe), depth + 1)

    status = 0
    for root in roots or ["."]:
        shown = tree_name(root, utf8)
        if os.path.isdir(root):
            try:
                entries = listing(root)
            except OSError:
                out.append(f"{shown}  [error opening dir]")
                status = 2
                continue
            out.append(shown)
            dirs += 1 if entries else 0
            walk(entries, "", 1)
        else:
            out.append(f"{shown}  [error opening dir]")
            if os.path.lexists(root):
                files += 1
            else:
                status = 2
    if not noreport:
        out.append("")
        report = f"{dirs} director{'y' if dirs == 1 else 'ies'}"
        out.append(report if dirs_only else f"{report}, {files} file{'' if files == 1 else 's'}")
    sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8", "surrogateescape"))
    return status


def tree_utf8():
    """Whether tree draws in UTF-8: as the locale says, the first of LC_ALL, LC_CTYPE and LANG that is set.

    With none of them set — as in this sandbox, whose terminal and python are
    both UTF-8 regardless — it draws in UTF-8, where tree on a machine with
    no locale at all would fall back to ASCII. LC_ALL=C gets tree's ASCII.
    """
    for name in ("LC_ALL", "LC_CTYPE", "LANG"):
        value = os.environ.get(name)
        if value:
            return "utf8" in value.lower().replace("-", "")
    return True


def tree_name(name, utf8):
    """A name as tree 2.1 prints it.

    In UTF-8, an unprintable character's bytes become octal escapes. In a
    single-byte locale every byte outside printable ASCII does, and a space
    and a backslash are escaped too — tree's `a\\ b`.
    """
    raw = os.fsencode(name)
    if utf8:
        import unicodedata

        out = []
        for ch in raw.decode("utf-8", "surrogateescape"):
            if "\udc80" <= ch <= "\udcff":
                out.append("\\%03o" % (ord(ch) - 0xDC00))
            elif ch.isprintable() or unicodedata.category(ch) == "Zs":
                out.append(ch)
            else:
                out.append("".join("\\%03o" % b for b in ch.encode("utf-8")))
        return "".join(out)
    out = []
    for b in raw:
        if 7 <= b <= 13:
            out.append("\\" + "abtnvfr"[b - 7])
        elif b in (0x20, 0x5C):
            out.append("\\" + chr(b))
        elif 0x20 < b < 0x7F:
            out.append(chr(b))
        else:
            out.append("\\%03o" % b)
    return "".join(out)


# ------------------------------------------------------- sha256sum / md5sum
def cmd_sum(argv, algorithm):
    tool = f"{algorithm}sum"
    check, files = False, []
    for a in argv:
        if a in ("-c", "--check"):
            check = True
        elif a.startswith("-") and a != "-":
            die(tool, f"unsupported option '{a}'. Supported: -c")
        else:
            files.append(a)

    def digest_of(name):
        h = hashlib.new(algorithm)
        if name == "-":
            h.update(sys.stdin.buffer.read())
        else:
            with open(name, "rb") as f:
                for block in iter(lambda: f.read(65536), b""):
                    h.update(block)
        return h.hexdigest()

    if check:
        bad = 0
        for name in files or ["-"]:
            for line in read_text(name, tool).splitlines():
                if not line.strip():
                    continue
                want, _, target = line.partition("  ")
                ok = digest_of(target) == want
                print(f"{target}: {'OK' if ok else 'FAILED'}")
                bad += 0 if ok else 1
        return 1 if bad else 0

    for name in files or ["-"]:
        print(f"{digest_of(name)}  {name}")
    return 0


# ---------------------------------------------------------------- du
#
# Reports *apparent* size, which is what GNU calls `du --apparent-size`, not
# the default. Real du counts allocated blocks, and this filesystem has no
# block allocation to count — a 3000-byte file occupies 3000 bytes here and
# 4096 on a disk. Reporting a number invented to look like a real one would be
# worse than reporting the one that is true.
#
# Otherwise it is GNU's: a line for every directory, deepest first, in the
# order the directory lists them; a file's size and a symlink's own, never a
# directory's (GNU counts st_size only for those two); a file with several
# links counted once, and with more than one argument anything already
# counted skipped — which is why `du -s dir dir/sub` prints one line.
def cmd_du(argv):
    summarise, all_files, total, null, max_depth, unit, paths = False, False, False, False, None, 1024, []
    separate, one_fs = False, False
    supported = "Supported: -s -a -c -h -k -m -b -0 -S -x -d N --apparent-size"
    longs = {"--summarize": "s", "--all": "a", "--total": "c", "--human-readable": "h", "--bytes": "b",
             "--null": "0", "--separate-dirs": "S", "--one-file-system": "x", "--apparent-size": ""}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            paths.extend(argv[i + 1 :])
            break
        if not a.startswith("-") or a == "-":
            paths.append(a)
            i += 1
            continue
        if a.startswith("--"):
            key, eq, value = a.partition("=")
            if key == "--max-depth":
                if not eq:
                    i += 1
                    value = argv[i] if i < len(argv) else ""
                flags = "d"
            elif key in longs and not eq:
                flags = longs[key]
            else:
                die("du", f"unsupported option '{a}'. {supported}")
        else:
            flags = a[1:]
        for j, flag in enumerate(flags):
            if flag == "s":
                summarise = True
            elif flag == "a":
                all_files = True
            elif flag == "c":
                total = True
            elif flag == "0":
                null = True
            elif flag == "S":
                separate = True
            elif flag == "x":
                one_fs = True
            elif flag in "hkmb":
                unit = {"h": None, "k": 1024, "m": 1024 * 1024, "b": 1}[flag]
            elif flag == "d":
                if not a.startswith("--"):
                    value = flags[j + 1 :]
                    if not value:
                        i += 1
                        value = argv[i] if i < len(argv) else ""
                if not value.isdigit():
                    sys.stderr.write(f"du: invalid maximum depth '{value}'\nTry 'du --help' for more information.\n")
                    return 1
                max_depth = int(value)
                break
            else:
                die("du", f"unsupported option '-{flag}'. {supported}")
        i += 1
    if summarise and all_files:
        sys.stderr.write("du: cannot both summarize and show all entries\nTry 'du --help' for more information.\n")
        return 1
    if summarise:
        if max_depth:
            sys.stderr.write(f"du: warning: summarizing conflicts with --max-depth={max_depth}\nTry 'du --help' for more information.\n")
            return 1
        if max_depth == 0:
            sys.stderr.write("du: warning: summarizing is the same as using --max-depth=0\n")
        max_depth = 0
    paths = paths or ["."]
    hash_all = len(paths) > 1
    seen, status, grand = set(), 0, 0
    end = "\0" if null else "\n"

    def show(size, name):
        amount = du_human(size) if unit is None else str(-(-size // unit))
        sys.stdout.write(f"{amount}\t{name}{end}")

    def visit(path, st, depth, device):
        nonlocal status, grand
        is_dir = stat.S_ISDIR(st.st_mode)
        if hash_all or (not is_dir and st.st_nlink > 1):
            key = (st.st_dev, st.st_ino)
            if key in seen:
                return 0
            seen.add(key)
        size = st.st_size if stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode) else 0
        grand += size
        if is_dir:
            try:
                names = [entry.name for entry in os.scandir(path)]
            except OSError as e:
                sys.stderr.write(f"du: cannot read directory '{path}': {e.strerror}\n")
                status, names = 1, []
            for name in names:
                child = os.path.join(path, name)
                try:
                    child_st = os.lstat(child)
                except OSError as e:
                    sys.stderr.write(f"du: cannot access '{child}': {e.strerror}\n")
                    status = 1
                    continue
                if one_fs and child_st.st_dev != device:
                    continue
                inner = visit(child, child_st, depth + 1, device)
                size += 0 if separate and stat.S_ISDIR(child_st.st_mode) else inner
        if (is_dir or all_files or depth == 0) and (max_depth is None or depth <= max_depth):
            show(size, path)
        return size

    for path in paths:
        try:
            st = os.lstat(path)
        except OSError as e:
            sys.stderr.write(f"du: cannot access '{path}': {e.strerror}\n")
            status = 1
            continue
        visit(path, st, 0, st.st_dev)
    if total:
        show(grand, "total")
    return status


def du_human(size):
    """GNU's -h: powers of 1024, one decimal below 10, and always rounded up."""
    if size < 1024:
        return str(size)
    units, power, exponent = "KMGTPEZYRQ", 1024, 1
    while exponent < len(units) and size >= power * 1024:
        power, exponent = power * 1024, exponent + 1
    if size * 10 < power * 100:
        tenths = -(-size * 10 // power)
        if tenths < 100:
            return f"{tenths // 10}.{tenths % 10}{units[exponent - 1]}"
        return f"10{units[exponent - 1]}"
    whole = -(-size // power)
    if whole >= 1024 and exponent < len(units):
        return f"1.0{units[exponent]}"
    return f"{whole}{units[exponent - 1]}"


# ---------------------------------------------------------------- stat
def shell_quote(name):
    """A name quoted the way GNU tools quote one (gnulib's shell-escape-always).

    'a b', "it's", and 'a'$'\\n''b' for a name with a control character in it.
    """
    if not name:
        return "''"
    printable = all(ch.isprintable() for ch in name)
    if printable and "'" not in name:
        return f"'{name}'"
    if printable and not any(ch in name for ch in "\"$`\\!"):
        return f'"{name}"'
    out, run = [], []
    named = {"\a": "a", "\b": "b", "\t": "t", "\n": "n", "\v": "v", "\f": "f", "\r": "r"}

    def flush():
        if run:
            out.append("'" + "".join(run) + "'")
            run.clear()

    for ch in name:
        if ch == "'":
            flush()
            out.append("\\'")
        elif not ch.isprintable():
            flush()
            if ch in named:
                out.append(f"$'\\{named[ch]}'")
            else:
                out.append("$'" + "".join(f"\\{b:03o}" for b in ch.encode("utf-8", "surrogateescape")) + "'")
        else:
            run.append(ch)
    flush()
    return "".join(out)


def cmd_stat(argv):
    """GNU stat on files: its default layout, -c, --printf, -t and -L, and its %-directives.

    Without -L it describes a symlink rather than what the link points to, as
    stat does. Python's stat has no birth time, so %w is '-' and %W is 0 —
    what GNU prints where a system keeps none.
    """
    fmt, printf, terse, follow, files = None, False, False, False, []

    def usage_error(message):
        sys.stderr.write(f"stat: {message}\nTry 'stat --help' for more information.\n")
        raise SystemExit(1)

    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            files.extend(argv[i + 1 :])
            break
        if a.startswith("--"):
            key, eq, value = a.partition("=")
            if key in ("--format", "--printf"):
                if not eq:
                    i += 1
                    if i >= len(argv):
                        usage_error(f"option '{key}' requires an argument")
                    value = argv[i]
                fmt, printf = value, key == "--printf"
            elif key in ("--dereference", "--terse") and not eq:
                follow, terse = follow or key == "--dereference", terse or key == "--terse"
            else:
                die("stat", f"unsupported option '{a}'. Supported: -c FORMAT --printf=FORMAT -t -L")
        elif a.startswith("-") and a != "-":
            for j, f in enumerate(a[1:], start=1):
                if f == "L":
                    follow = True
                elif f == "t":
                    terse = True
                elif f == "c":
                    value = a[j + 1 :]
                    if not value:
                        i += 1
                        if i >= len(argv):
                            usage_error("option requires an argument -- 'c'")
                        value = argv[i]
                    fmt, printf = value, False
                    break
                else:
                    die("stat", f"unsupported option '-{f}'. Supported: -c FORMAT --printf=FORMAT -t -L")
        else:
            files.append(a)
        i += 1
    if not files:
        usage_error("missing operand")

    status = 0
    for name in files:
        try:
            st = os.fstat(0) if name == "-" else os.stat(name) if follow else os.lstat(name)
        except OSError as e:
            sys.stderr.write(f"stat: cannot statx {shell_quote(name)}: {e.strerror}\n")
            status = 1
            continue
        tail = b""
        if fmt is not None:
            text, escapes, tail = fmt, printf, b"" if printf else b"\n"
        elif terse:
            text, escapes = "%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o\n", False
        else:
            special = stat.S_ISCHR(st.st_mode) or stat.S_ISBLK(st.st_mode)
            text = (
                "  Size: %-10s\tBlocks: %-10b IO Block: %-6o %F\n"
                + ("Device: %Hd,%Ld\tInode: %-11i Links: %-5h Device type: %Hr,%Lr\n" if special
                   else "Device: %Hd,%Ld\tInode: %-11i Links: %h\n")
                + "Access: (%04a/%10.10A)  Uid: (%5u/%8U)   Gid: (%5g/%8G)\n"
                + "Access: %x\nModify: %y\nChange: %z\n Birth: %w\n"
            )
            escapes = False
            # The default layout names the file as it is, unquoted.
            target = f" -> {os.readlink(name)}" if stat.S_ISLNK(st.st_mode) else ""
            sys.stdout.buffer.write(f"  File: {name}{target}\n".encode("utf-8", "surrogateescape"))
        sys.stdout.buffer.write(stat_format(text, name, st, escapes) + tail)
    return status


def stat_format(fmt, name, st, escapes):
    """GNU stat's print_it(): the %-directives, with printf's flags, width and precision."""
    import time

    out = bytearray()

    def put(text):
        out.extend(text.encode("utf-8", "surrogateescape"))

    def device(number):
        if hasattr(os, "major"):
            return os.major(number), os.minor(number)
        return (number >> 8) & 0xFFF, (number & 0xFF) | ((number >> 12) & 0xFFF00)

    def when(field):
        ns = getattr(st, f"st_{field}time_ns")
        return divmod(ns, 10**9)

    def human_time(field):
        sec, ns = when(field)
        moment = time.localtime(sec)
        return time.strftime("%Y-%m-%d %H:%M:%S", moment) + f".{ns:09d} " + time.strftime("%z", moment)

    def epoch(spec, sec, ns):
        flags, _, precision = spec.partition(".")
        if not _:
            return ("%" + flags + "d") % sec
        places = int(precision) if precision.isdigit() else 9
        if not places:
            return ("%" + flags.rstrip("0123456789") + "d") % sec
        width_text = flags.lstrip("-+ #0")
        width = int(width_text) if width_text else 0
        flags = flags[: len(flags) - len(width_text)]
        seconds_width = 0 if "-" in flags else width - 1 - places
        text = ("%" + flags.replace("-", "") + (str(seconds_width) if seconds_width > 1 else "") + "d") % sec
        text += "." + f"{ns:09d}"[: min(places, 9)] + "0" * max(0, places - 9)
        return text.ljust(width) if "-" in flags else text

    def name_of(table, number):
        try:
            module = __import__(table)
            return (module.getpwuid(number).pw_name if table == "pwd" else module.getgrgid(number).gr_name)
        except (ImportError, KeyError, OSError):
            return "UNKNOWN"

    def mount_point():
        here = os.path.abspath(name)
        if not stat.S_ISDIR(st.st_mode):
            here = os.path.dirname(here)
        try:
            dev = os.stat(here).st_dev
            while here != os.path.dirname(here) and os.stat(os.path.dirname(here)).st_dev == dev:
                here = os.path.dirname(here)
        except OSError:
            return "?"
        return here

    i = 0
    while i < len(fmt):
        ch = fmt[i]
        if ch == "\\" and escapes:
            i += 1
            nxt = fmt[i : i + 1]
            if nxt and nxt in "01234567":
                digits = nxt
                while len(digits) < 3 and fmt[i + len(digits) : i + len(digits) + 1] in tuple("01234567"):
                    digits += fmt[i + len(digits)]
                out.append(int(digits, 8) & 0xFF)
                i += len(digits)
                continue
            if nxt == "x" and fmt[i + 1 : i + 2] and fmt[i + 1] in "0123456789abcdefABCDEF":
                digits = fmt[i + 1]
                if fmt[i + 2 : i + 3] and fmt[i + 2] in "0123456789abcdefABCDEF":
                    digits += fmt[i + 2]
                out.append(int(digits, 16))
                i += 1 + len(digits)
                continue
            if not nxt:
                sys.stderr.write("stat: warning: backslash at end of format\n")
                put("\\")
                continue
            named = {"a": "\a", "b": "\b", "e": "\x1b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", '"': '"', "\\": "\\"}
            if nxt not in named:
                sys.stderr.write(f"stat: warning: unrecognized escape '\\{nxt}'\n")
            put(named.get(nxt, nxt))
            i += 1
            continue
        if ch != "%":
            put(ch)
            i += 1
            continue
        j = i + 1
        while j < len(fmt) and fmt[j] in "'-+ #0I":
            j += 1
        while j < len(fmt) and fmt[j].isdigit():
            j += 1
        if j < len(fmt) and fmt[j] == ".":
            j += 1
            while j < len(fmt) and fmt[j].isdigit():
                j += 1
        spec = fmt[i + 1 : j].replace("'", "").replace("I", "")
        code = fmt[j : j + 1]
        if code in ("", "%"):
            if fmt[i + 1 : j]:
                sys.stderr.write(f"stat: '{fmt[i : j + 1]}': invalid directive\n")
                raise SystemExit(1)
            put("%")
            i = j + (1 if code else 0)
            continue
        if code in "HL" and fmt[j + 1 : j + 2] in ("d", "r"):
            major, minor = device(st.st_dev if fmt[j + 1] == "d" else st.st_rdev)
            put(("%" + spec + "d") % (major if code == "H" else minor))
            i = j + 2
            continue
        i = j + 1
        mode = st.st_mode
        number = {
            "a": ("o", stat.S_IMODE(mode)), "b": ("d", getattr(st, "st_blocks", 0)), "B": ("d", 512),
            "d": ("d", st.st_dev), "D": ("x", st.st_dev), "f": ("x", mode), "g": ("d", st.st_gid),
            "h": ("d", st.st_nlink), "i": ("d", st.st_ino), "o": ("d", getattr(st, "st_blksize", 0)),
            "s": ("d", st.st_size), "u": ("d", st.st_uid), "r": ("d", getattr(st, "st_rdev", 0)),
            "R": ("x", getattr(st, "st_rdev", 0)), "t": ("x", device(getattr(st, "st_rdev", 0))[0]),
            "T": ("x", device(getattr(st, "st_rdev", 0))[1]),
        }
        if code in number:
            conversion, value = number[code]
            if conversion == "o" and "#" in spec:
                # C's alternate octal is 0644, where python's is 0o644.
                flags = spec.split(".")[0]
                width = int(flags.lstrip("-+ #0") or 0)
                digits = "%o" % value
                digits = digits if digits.startswith("0") else "0" + digits
                pad = "0" if "0" in flags[: len(flags) - len(flags.lstrip("-+ #0"))] and "-" not in flags else " "
                put(digits.ljust(width) if "-" in flags else digits.rjust(width, pad))
            else:
                put(("%" + spec + conversion) % value)
            continue
        if code in "XYZ":
            put(epoch(spec, *when({"X": "a", "Y": "m", "Z": "c"}[code])))
            continue
        if code == "W":
            put(epoch(spec, 0, 0))
            continue
        if code == "N":
            text = shell_quote(name)
            if stat.S_ISLNK(mode):
                text += " -> " + shell_quote(os.readlink(name))
        elif code == "n":
            text = name
        elif code == "F":
            text = stat_type(st)
        elif code == "A":
            text = stat.filemode(mode)
        elif code == "U":
            text = name_of("pwd", st.st_uid)
        elif code == "G":
            text = name_of("grp", st.st_gid)
        elif code in "xyz":
            text = human_time({"x": "a", "y": "m", "z": "c"}[code])
        elif code == "w":
            text = "-"
        elif code == "m":
            text = mount_point()
        else:
            put("?")
            continue
        put(("%" + spec + "s") % text)
    return bytes(out)


def stat_type(st):
    mode = st.st_mode
    if stat.S_ISREG(mode):
        return "regular empty file" if st.st_size == 0 else "regular file"
    for test, kind in ((stat.S_ISDIR, "directory"), (stat.S_ISLNK, "symbolic link"), (stat.S_ISFIFO, "fifo"),
                       (stat.S_ISSOCK, "socket"), (stat.S_ISCHR, "character special file"),
                       (stat.S_ISBLK, "block special file")):
        if test(mode):
            return kind
    return "weird file"


# ---------------------------------------------------------------- split
def cmd_split(argv):
    """GNU split: -l, -b, -C and -n in all its forms, on bytes.

    Read and written as bytes: a CR, or a byte that is not UTF-8, is data like
    any other. The chunking is GNU's own code ported — split.c's
    bytes_split, line_bytes_split, lines_chunk_split and lines_rr — so the
    pieces come out the sizes GNU makes them, empty ones included. With no -a
    the suffixes widen as GNU's do: after xyz comes xzaaa.
    """
    import re

    def fail(message, hint=False):
        sys.stderr.write(f"split: {message}\n" + ("Try 'split --help' for more information.\n" if hint else ""))
        raise SystemExit(1)

    def size_of(text, what):
        # xstrtoimax with split's suffixes: b is 512, K/k and KiB 1024, KB 1000, and on up.
        m = re.fullmatch(r"(\d+)(?:([bkKmMGTPEZYRQ])(B|iB)?)?", text)
        if m and not (m.group(2) == "b" and m.group(3)):
            n, letter, tail = int(m.group(1)), m.group(2), m.group(3)
            if letter == "b":
                n *= 512
            elif letter:
                n *= (1000 if tail == "B" else 1024) ** ("KMGTPEZYRQ".index(letter.upper()) + 1)
            if n > 0:
                return n
        fail(f"invalid number of {what}: '{text}'")

    def whole(text, what):
        if not text.isdigit() or int(text) == 0:
            fail(f"invalid number of {what}: '{text}'")
        return int(text)

    mode, amount, chunk = None, 1000, (0, 0)
    alphabet, width, width_given, extra, elide, verbose, sep = "abcdefghijklmnopqrstuvwxyz", 2, False, "", False, False, b"\n"
    operands, i = [], 0

    def set_mode(new, value):
        nonlocal mode, amount
        if mode is not None and mode != new:
            fail("cannot split in more than one way", hint=True)
        mode, amount = new, value

    def set_chunks(text):
        nonlocal chunk
        kind, _, rest = text.partition("/") if text[:2] in ("l/", "r/") else ("", "", text)
        k, slash, n = rest.partition("/")
        if not slash:
            k, n = "0", k
        n = whole(n, "chunks")
        if not k.isdigit() or (slash and not 0 < int(k) <= n):
            fail(f"invalid chunk number: '{k}'")
        set_mode({"": "chunks", "l": "linechunks", "r": "rr"}[kind], n)
        chunk = (int(k), n)

    longs = {"--bytes": "b", "--line-bytes": "C", "--lines": "l", "--number": "n", "--suffix-length": "a",
             "--separator": "t", "--additional-suffix": "S"}
    while i < len(argv):
        a = argv[i]
        if a == "--":
            operands.extend(argv[i + 1 :])
            break
        if not a.startswith("-") or a == "-":
            operands.append(a)
            i += 1
            continue
        pairs = []
        if a.startswith("--"):
            key, eq, value = a.partition("=")
            if key in longs:
                if not eq:
                    i += 1
                    if i >= len(argv):
                        fail(f"option '{key}' requires an argument", hint=True)
                    value = argv[i]
                pairs.append((longs[key], value))
            elif key in ("--numeric-suffixes", "--hex-suffixes") and not eq:
                pairs.append(("d" if key == "--numeric-suffixes" else "x", None))
            elif key in ("--elide-empty-files", "--verbose", "--unbuffered") and not eq:
                pairs.append(({"--elide-empty-files": "e", "--verbose": "V", "--unbuffered": "u"}[key], None))
            else:
                die("split", f"unsupported option '{a}'. Supported: -l N -b SIZE -C SIZE -n CHUNKS -a N -d -x -e -t SEP -u --additional-suffix=SUF --verbose")
        elif a[1:].isdigit():
            pairs.append(("l", a[1:]))  # the obsolete -NUM, which is -l NUM
        else:
            j = 1
            while j < len(a):
                f = a[j]
                if f in "bClnat":
                    value = a[j + 1 :]
                    if not value:
                        i += 1
                        if i >= len(argv):
                            fail(f"option requires an argument -- '{f}'", hint=True)
                        value = argv[i]
                    pairs.append((f, value))
                    break
                if f not in "dexu":
                    die("split", f"unsupported option '-{f}'. Supported: -l N -b SIZE -C SIZE -n CHUNKS -a N -d -x -e -t SEP -u --additional-suffix=SUF --verbose")
                pairs.append((f, None))
                j += 1
        for f, value in pairs:
            if f == "l":
                set_mode("lines", whole(value, "lines"))
            elif f == "b":
                set_mode("bytes", size_of(value, "bytes"))
            elif f == "C":
                set_mode("linebytes", size_of(value, "bytes"))
            elif f == "n":
                set_chunks(value)
            elif f == "a":
                if not value.isdigit():
                    fail(f"invalid suffix length: '{value}'")
                width, width_given = (int(value), True) if int(value) else (2, False)
            elif f == "d":
                alphabet = "0123456789"
            elif f == "x":
                alphabet = "0123456789abcdef"
            elif f == "e":
                elide = True
            elif f == "V":
                verbose = True
            elif f == "S":
                if "/" in value:
                    fail(f"invalid suffix '{value}', contains directory separator")
                extra = value
            elif f == "t":
                raw = os.fsencode(value)
                if raw == b"\\0":
                    raw = b"\0"
                if len(raw) != 1:
                    fail(f"multi-character separator '{value}'" if raw else "empty record separator")
                sep = raw
        i += 1
    if len(operands) > 2:
        fail(f"extra operand '{operands[2]}'", hint=True)
    source = operands[0] if operands else "-"
    prefix = operands[1] if len(operands) > 1 else "x"
    mode = mode or "lines"

    auto = not width_given and mode in ("lines", "bytes", "linebytes")
    if mode in ("chunks", "linechunks", "rr"):
        needed, last = 1, chunk[1] - 1
        while last >= len(alphabet):
            needed, last = needed + 1, last // len(alphabet)
        if width_given and width < needed:
            fail(f"the suffix length needs to be at least {needed}")
        width = max(width, needed)

    def names():
        # GNU's widening: with no -a, the suffixes that would start with the
        # alphabet's last letter are not used; that letter joins the prefix
        # and the suffix grows by one instead.
        size, head = width, ""
        while True:
            count = (len(alphabet) - 1) * len(alphabet) ** (size - 1) if auto and size else len(alphabet) ** size
            for k in range(count):
                digits = []
                for _ in range(size):
                    k, d = divmod(k, len(alphabet))
                    digits.append(alphabet[d])
                yield prefix + head + "".join(reversed(digits)) + extra
            if not auto:
                fail("output file suffixes exhausted")
            size, head = size + 1, head + alphabet[-1]

    try:
        if source == "-":
            data, here = sys.stdin.buffer.read(), os.fstat(0)
        else:
            with open(source, "rb") as f:
                data, here = f.read(), os.fstat(f.fileno())
    except IsADirectoryError as e:
        fail(f"read error on '{source}': {e.strerror}")
    except OSError as e:
        fail(f"cannot open '{source}' for reading: {e.strerror}")

    generated = names()
    current = [None]

    def open_next():
        name = next(generated)
        return open_next_named(name, here, verbose)

    def cwrite(new, piece):
        # split.c's cwrite(): a new file when asked for one (unless -e and it
        # would stay empty), then the bytes, if there are any.
        if new:
            if piece is None and elide:
                return
            if current[0]:
                current[0].close()
            current[0] = open_next()
        if piece:
            current[0].write(piece)

    k, n = chunk
    if mode == "lines":
        lines = data.split(sep)
        tail = lines.pop()
        rows = [line + sep for line in lines] + ([tail] if tail else [])
        for start in range(0, len(rows), amount):
            cwrite(True, b"".join(rows[start : start + amount]))
    elif mode == "bytes":
        split_bytes(data, amount, 0, 0, cwrite)
    elif mode == "chunks" and not k:
        split_bytes(data, len(data) // n, len(data) % n, n, cwrite)
    elif mode == "chunks":
        size = len(data)
        start = (k - 1) * (size // n) + min(k - 1, size % n)
        end = size if k == n else k * (size // n) + min(k, size % n)
        sys.stdout.buffer.write(data[start:end])
    elif mode == "linebytes":
        split_line_bytes(data, amount, sep, cwrite)
    elif mode == "linechunks":
        split_line_chunks(data, k, n, sep, cwrite, sys.stdout.buffer.write)
    else:
        lines = data.split(sep)
        tail = lines.pop()
        rows = [line + sep for line in lines] + ([tail] if tail else [])
        if k:
            sys.stdout.buffer.write(b"".join(rows[k - 1 :: n]))
        else:
            files = [next(generated) for _ in range(n)]
            outputs = {}
            for index, row in enumerate(rows):
                which = index % n
                if which not in outputs:
                    outputs[which] = open_next_named(files[which], here, verbose)
                outputs[which].write(row)
            for which in range(n):
                if which not in outputs and not elide:
                    outputs[which] = open_next_named(files[which], here, verbose)
            for f in outputs.values():
                f.close()
    if current[0]:
        current[0].close()
    return 0


def open_next_named(name, here, verbose):
    """One of split's output files, opened — and refused if it is the input itself, as GNU refuses it."""
    try:
        if stat.S_ISREG(here.st_mode) and os.path.samestat(here, os.stat(name)):
            sys.stderr.write(f"split: '{name}' would overwrite input; aborting\n")
            raise SystemExit(1)
    except FileNotFoundError:
        pass
    if verbose:
        sys.stdout.write(f"creating file {shell_quote(name)}\n")
        sys.stdout.flush()
    try:
        return open(name, "wb")
    except OSError as e:
        sys.stderr.write(f"split: {name}: {e.strerror}\n")
        raise SystemExit(1)


def split_bytes(data, n_bytes, rem_bytes, max_files, cwrite):
    """split.c's bytes_split(), for -b and -n N, with the whole input as one read."""
    new, opened, pos, left = True, 0, 0, len(data)
    to_write = n_bytes + (0 < rem_bytes)
    if to_write:
        while 0 < to_write <= left:
            cwrite(new, data[pos : pos + to_write])
            opened += new
            new = not max_files or opened < max_files
            pos, left = pos + to_write, left - to_write
            to_write = n_bytes + (opened < rem_bytes)
        if left > 0:
            cwrite(new, data[pos:])
            opened += new
    while opened < max_files:
        cwrite(True, None)
        opened += 1


def split_line_bytes(data, n_bytes, sep, cwrite):
    """split.c's line_bytes_split(), for -C: whole lines up to SIZE bytes a file."""
    n_out, hold, split_line = 0, bytearray(), False
    sob, n_left = 0, len(data)
    while n_left:
        split_rest, eoc = 0, False
        if n_bytes - n_out - len(hold) <= n_left:
            split_rest, eoc = n_bytes - n_out - len(hold), True
            eol = data.rfind(sep, sob, sob + split_rest)
        else:
            eol = data.rfind(sep, sob, sob + n_left)
        if hold and not (eol < 0 and n_out):
            cwrite(n_out == 0, bytes(hold))
            n_out += len(hold)
            hold.clear()
        if eol >= 0:
            split_line = True
            n_write = eol - sob + 1
            cwrite(n_out == 0, data[sob : sob + n_write])
            n_out, n_left, sob = n_out + n_write, n_left - n_write, sob + n_write
            if eoc:
                split_rest -= n_write
        if n_left and not split_line:
            n_write = split_rest if eoc else n_left
            cwrite(n_out == 0, data[sob : sob + n_write])
            n_out, n_left, sob = n_out + n_write, n_left - n_write, sob + n_write
            if eoc:
                split_rest -= n_write
        if (eoc and split_rest) or (not eoc and n_left):
            n_buf = split_rest if eoc else n_left
            hold += data[sob : sob + n_buf]
            n_left, sob = n_left - n_buf, sob + n_buf
        if eoc:
            n_out, split_line = 0, False
    if hold:
        cwrite(n_out == 0, bytes(hold))


def split_line_chunks(data, k, n, sep, cwrite, to_stdout):
    """split.c's lines_chunk_split(), for -n l/N and l/K/N: N pieces by size, ending on line ends."""
    size = len(data)
    rem_bytes, chunk_size = size % n, size // n
    chunk_no, chunk_end, n_written, new, truncated = 1, chunk_size + (0 < rem_bytes), 0, True, False
    if k > 1 and size > 0:
        start = (k - 1) * chunk_size + min(k - 1, rem_bytes) - 1
        n_written, chunk_no, chunk_end = start, k - 1, start + 1
    while n_written < size:
        bp, eob = n_written, size
        while bp != eob:
            skip = min(eob - bp, max(0, chunk_end - 1 - n_written))
            found = data.find(sep, bp + skip, eob)
            nxt = found >= 0
            bp_out = found + 1 if nxt else eob
            if k == chunk_no:
                to_stdout(data[bp:bp_out])
            elif not k:
                cwrite(new, data[bp:bp_out])
            n_written += bp_out - bp
            bp = bp_out
            new = nxt
            while nxt or chunk_end <= n_written:
                if not nxt and bp == eob:
                    truncated = True
                    break
                if k == chunk_no:
                    return
                chunk_end += chunk_size + (chunk_no < rem_bytes)
                chunk_no += 1
                if chunk_end <= n_written:
                    if not k:
                        cwrite(True, None)
                else:
                    nxt = False
    if truncated:
        chunk_no += 1
    if not k:
        while chunk_no <= n:
            cwrite(True, None)
            chunk_no += 1


# ---------------------------------------------------------------- xargs
def cmd_xargs(argv):
    max_args, replace, null, trace = None, None, False, False
    command = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("-n"):
            max_args = int(a[2:] or argv[(i := i + 1)])
        elif a.startswith("-I"):
            replace = a[2:] or argv[(i := i + 1)]
        elif a in ("-0", "--null"):
            null = True
        elif a == "-t":
            trace = True
        elif a.startswith("-") and a != "-" and not command:
            die("xargs", f"unsupported option '{a}'. Supported: -n N -I STR -0 -t")
        else:
            command = argv[i:]
            break
        i += 1
    command = command or ["echo"]

    data = sys.stdin.read()
    items = [x for x in (data.split("\0") if null else data.split()) if x]
    if not items:
        return 0

    batches = []
    if replace is not None:
        batches = [[item] for item in items]
    elif max_args:
        batches = [items[i : i + max_args] for i in range(0, len(items), max_args)]
    else:
        batches = [items]

    status = 0
    for batch in batches:
        if replace is not None:
            line = [part.replace(replace, batch[0]) for part in command]
        else:
            line = command + batch
        if trace:
            sys.stderr.write(" ".join(line) + "\n")
        result = subprocess.run(line)
        status = result.returncode or status
    return status


# ------------------------------------------------------------ zip / unzip
def cmd_zip(argv):
    recurse, files = False, []
    for a in argv:
        if a in ("-r", "-R"):
            recurse = True
        elif a.startswith("-"):
            die("zip", f"unsupported option '{a}'. Supported: -r")
        else:
            files.append(a)
    if len(files) < 2:
        die("zip", "needs an archive and at least one file")
    archive, targets = files[0], files[1:]
    if not archive.endswith(".zip"):
        archive += ".zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for target in targets:
            if os.path.isdir(target):
                if not recurse:
                    sys.stderr.write(f"zip: {target} is a directory; use -r\n")
                    continue
                for root, _, names in os.walk(target):
                    for name in names:
                        full = os.path.join(root, name)
                        z.write(full)
                        print(f"  adding: {full}")
            else:
                z.write(target)
                print(f"  adding: {target}")
    return 0


def cmd_unzip(argv):
    listing, dest, files = False, ".", []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "-l":
            listing = True
        elif a == "-d":
            i += 1
            dest = argv[i]
        elif a.startswith("-"):
            die("unzip", f"unsupported option '{a}'. Supported: -l -d DIR")
        else:
            files.append(a)
        i += 1
    if not files:
        die("unzip", "needs an archive")
    try:
        with zipfile.ZipFile(files[0]) as z:
            if listing:
                print("  Length      Name")
                for info in z.infolist():
                    print(f"{info.file_size:>8}      {info.filename}")
                return 0
            z.extractall(dest)
            for info in z.infolist():
                print(f"  inflating: {info.filename}")
    except (OSError, zipfile.BadZipFile) as e:
        die("unzip", f"cannot open {files[0]}: {e}", code=9)
    return 0




# ---------------------------------------------------------------- patch
def cmd_patch(argv):
    """Apply a unified diff.

    Context matching only, with no fuzz: a hunk whose context does not match
    is refused rather than guessed at. `patch` guessing wrong is how a file
    silently becomes something nobody wrote.
    """
    strip, target, reverse, dry = 1, None, False, False
    patch_file = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("-p"):
            strip = int(a[2:] or argv[(i := i + 1)])
        elif a in ("-i", "--input"):
            i += 1
            patch_file = argv[i]
        elif a in ("-R", "--reverse"):
            reverse = True
        elif a == "--dry-run":
            dry = True
        elif a.startswith("-") and a != "-":
            die("patch", f"unsupported option '{a}'. Supported: -pN -i FILE -R --dry-run")
        else:
            target = a
        i += 1

    text = read_text(patch_file, "patch") if patch_file else sys.stdin.read()
    lines = text.splitlines()

    # Split into per-file sections, then per-hunk within each.
    sections, current = [], None
    for line in lines:
        if line.startswith("--- "):
            current = {"old": line[4:].split("\t")[0], "new": None, "hunks": []}
            sections.append(current)
        elif line.startswith("+++ ") and current:
            current["new"] = line[4:].split("\t")[0]
        elif line.startswith("@@") and current:
            current["hunks"].append({"header": line, "body": []})
        elif current and current["hunks"]:
            current["hunks"][-1]["body"].append(line)

    if not sections:
        die("patch", "no unified diff found on input")

    def strip_path(path):
        parts = path.split("/")
        return "/".join(parts[strip:]) if strip < len(parts) else parts[-1]

    applied = 0
    for section in sections:
        name = target or strip_path(section["new"] or section["old"])
        original = read_text(name, "patch").splitlines(keepends=True)
        result = list(original)
        offset = 0
        for hunk in section["hunks"]:
            head = hunk["header"].split("@@")[1].strip()
            old_part = head.split(" ")[0]
            start = int(old_part[1:].split(",")[0]) - 1
            want, produce = [], []
            for line in hunk["body"]:
                tag, rest = (line[0], line[1:]) if line else (" ", "")
                if reverse:
                    tag = {"+": "-", "-": "+"}.get(tag, tag)
                if tag in (" ", "-"):
                    want.append(rest + "\n")
                if tag in (" ", "+"):
                    produce.append(rest + "\n")
            at = start + offset
            if result[at : at + len(want)] != want:
                die("patch", f"hunk failed to apply at {name}:{start + 1}", code=1)
            result[at : at + len(want)] = produce
            offset += len(produce) - len(want)
            applied += 1
        if not dry:
            with open(name, "w", errors="surrogateescape") as f:
                f.writelines(result)
        print(f"patching file {name}")
    return 0


# ---------------------------------------------------------------- cmp
def cmp_files(argv):
    silent, files = False, []
    for a in argv:
        if a in ("-s", "--silent", "--quiet"):
            silent = True
        elif a.startswith("-") and a != "-":
            die("cmp", f"unsupported option '{a}'. Supported: -s")
        else:
            files.append(a)
    if len(files) != 2:
        die("cmp", "needs exactly two files")
    left, right = (read_text(f, "cmp") for f in files)
    if left == right:
        return 0
    if not silent:
        for index, (a, b) in enumerate(zip(left, right), start=1):
            if a != b:
                line = left.count("\n", 0, index - 1) + 1
                print(f"{files[0]} {files[1]} differ: char {index}, line {line}")
                return 1
        shorter = files[0] if len(left) < len(right) else files[1]
        sys.stderr.write(f"cmp: EOF on {shorter}\n")
    return 1


# ------------------------------------------------------------ hexdump / xxd
def hexdump_size(value, what):
    """util-linux's reading of -n and -s: C's number (0x10, 010), then K, KiB or KB."""
    number, rest = c_number(value)
    if number is not None and number >= 0:
        if not rest:
            return number
        units = "KMGTPEZY"
        power = units.find(rest[0].upper()) + 1
        tail = rest[1:]
        if power and tail in ("", "iB", "ib"):
            return number * 1024 ** power
        if power and tail in ("B", "b"):
            return number * 1000 ** power
    die("hexdump", f"failed to parse {what}: '{value}': Invalid argument", 1)


def c_number(text):
    """strtol(text, NULL, 0): (the number, what was left), or (None, text).

    C reads 0x10 as sixteen and 010 as eight, and stops at the first character
    it cannot use — which is how xxd and hexdump read their numbers.
    """
    s = text.lstrip(" \t\n")
    sign = 1
    if s and s[0] in "+-":
        sign, s = (-1 if s[0] == "-" else 1), s[1:]
    if s[:2].lower() == "0x" and s[2:3] and s[2] in "0123456789abcdefABCDEF":
        base, digits, s = 16, "0123456789abcdefABCDEF", s[2:]
    elif s[:1] == "0":
        base, digits = 8, "01234567"
    else:
        base, digits = 10, "0123456789"
    end = 0
    while end < len(s) and s[end] in digits:
        end += 1
    if not end:
        return None, text
    return sign * int(s[:end], base), s[end:]


def write_all(fd, data):
    """os.write until it is all out: a pipe may take less than it is given."""
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view) :]


def cmd_hexdump(argv):
    """util-linux hexdump: its canned formats, -n, -s and -v, over every file named.

    Each canned format is one of hexdump's format strings worked through: an
    offset, then the units, the last unit of a line without its trailing space
    — hexdump's rule for a repeated unit, which is why a full line ends on a
    digit and a short one is padded to where a full one would end. Two-byte
    units are little-endian, and a lone last byte is zero-padded. A block the
    same as the one before it is a `*`, once, unless -v. The files are one
    stream, as they are to hexdump, and -s skips into it.
    """
    formats, length, skip, squeeze, files = [], None, 0, True, []
    longs = {"--one-byte-octal": "b", "--one-byte-char": "c", "--canonical": "C",
             "--two-bytes-decimal": "d", "--two-bytes-octal": "o", "--two-bytes-hex": "x",
             "--no-squeezing": "v"}
    supported = "Supported: -b -c -C -d -o -x -n LENGTH -s OFFSET -v"
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            files.extend(argv[i + 1 :])
            break
        if a.startswith("--"):
            key, eq, value = a.partition("=")
            if key in ("--length", "--skip"):
                if not eq:
                    i += 1
                    if i >= len(argv):
                        die("hexdump", f"option '{key}' requires an argument", 1)
                    value = argv[i]
                if key == "--length":
                    length = hexdump_size(value, "length")
                else:
                    skip = hexdump_size(value, "offset")
                i += 1
                continue
            if key not in longs or eq:
                die("hexdump", f"unsupported option '{a}'. {supported}")
            flags = longs[key]
        elif a.startswith("-") and a != "-":
            flags = a[1:]
        else:
            files.append(a)
            i += 1
            continue
        for j, f in enumerate(flags):
            if f in "bcCdox":
                formats.append(f)
            elif f == "v":
                squeeze = False
            elif f in "ns":
                value = flags[j + 1 :]
                if not value:
                    i += 1
                    if i >= len(argv):
                        die("hexdump", f"option requires an argument -- '{f}'", 1)
                    value = argv[i]
                if f == "n":
                    length = hexdump_size(value, "length")
                else:
                    skip = hexdump_size(value, "offset")
                break
            else:
                die("hexdump", f"unsupported option '-{f}'. {supported}")
        i += 1

    status = 0
    if not files:
        if skip:
            try:
                os.lseek(0, 0, os.SEEK_CUR)
            except OSError as e:
                die("hexdump", f"stdin: {e.strerror}", 1)
        data = sys.stdin.buffer.read()
    else:
        parts, opened = [], 0
        for name in files:
            try:
                with open(name, "rb") as f:
                    parts.append(f.read())
            except IsADirectoryError as e:
                # hexdump opens a directory and fails to read it, which it
                # reports without counting the file as one that failed.
                sys.stderr.write(f"hexdump: {name}: {e.strerror}\n")
                opened += 1
                continue
            except OSError as e:
                sys.stderr.write(f"hexdump: {name}: {e.strerror}\n")
                status = 1
                continue
            opened += 1
        if not opened:
            sys.stderr.write("hexdump: all input file arguments failed\n")
            return 1
        data = b"".join(parts)
    if length == 0:
        return status

    start = min(skip, len(data))
    shown = data[start:] if length is None else data[start : start + length]
    formats = formats or ["default"]
    out = []
    previous, starred = None, False
    for offset in range(0, len(shown), 16):
        block = shown[offset : offset + 16]
        if squeeze and len(block) == 16 and block == previous:
            if not starred:
                out.append("*\n")
                starred = True
            continue
        previous, starred = block, False
        for f in formats:
            out.append(hexdump_line(f, start + offset, block) + "\n")
    end = start + len(shown)
    if end:
        out.append(f"{end:08x}\n" if formats[-1] == "C" else f"{end:07x}\n")
    sys.stdout.write("".join(out))
    return status


def hexdump_line(kind, address, block):
    if kind == "C":
        hexes = [f"{b:02x}" for b in block] + ["  "] * (16 - len(block))
        text = "".join(chr(b) if 32 <= b < 127 else "." for b in block)
        return f"{address:08x}  {' '.join(hexes[:8])}  {' '.join(hexes[8:])}  |{text}|"
    if kind in "bc":
        if kind == "b":
            units = [f"{b:03o}" for b in block]
        else:
            named = {0: "\\0", 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r"}
            units = [(named.get(b) or (chr(b) if 32 <= b < 127 else f"{b:03o}")).rjust(3) for b in block]
        return f"{address:07x} " + " ".join(units + ["   "] * (16 - len(units)))
    shape = {"default": "{:04x}", "x": "   {:04x}", "d": "  {:05d}", "o": " {:06o}"}[kind]
    words = [block[k] | (block[k + 1] << 8 if k + 1 < len(block) else 0) for k in range(0, len(block), 2)]
    units = [shape.format(w) for w in words]
    blank = " " * len(shape.format(0))
    return f"{address:07x} " + " ".join(units + [blank] * (8 - len(units)))


def cmd_xxd(argv):
    """vim's xxd (9.1): the dump, -p, -i, -b, -e, -r and -r -p, and its options.

    The dump is laid out the way xxd.c lays it, column arithmetic and all, so
    -c, -g and -e put things where xxd puts them. Options are read as xxd reads
    them — by their first letter, so -ps and -plain are -p and -c8 is -c 8,
    with C's numbers (0x10 is sixteen, 010 is eight). The one difference: a
    cluster xxd would quietly read as its first letter alone — `-rp` is `-r`
    to xxd, not `-r -p` — is refused here rather than half-done.
    """
    hextype, autoskip, capitalize, decimal, upper, revert = "normal", False, False, False, False, False
    cols, group, length, seek, relseek, negseek, display, varname = None, None, -1, 0, False, False, 0, None

    def usage():
        sys.stderr.write(
            "Usage:\n       xxd [options] [infile [outfile]]\n    or\n"
            "       xxd -r [-s [-]offset] [-c cols] [-ps] [infile [outfile]]\n"
            "Supported here: -a -b -C -c cols -d -e -g bytes -i -l len -n name -o off -p -r -s [+][-]seek -u -R never|auto\n"
        )
        raise SystemExit(1)

    args = list(argv)
    while args:
        a = args[0]
        if a == "--":
            args.pop(0)
            break
        pp = a[1:] if a.startswith("--") and len(a) > 2 else a
        if not pp.startswith("-") or pp == "-":
            break
        args.pop(0)
        letter, rest = pp[1:2], pp[2:]

        def value(attached_unless):
            # xxd's option arguments: attached (-c8), or the next word when the
            # rest of the option is its long spelling (-cols 8) or nothing.
            if rest and not any(rest.startswith(w) for w in attached_unless):
                return rest
            if not args:
                usage()
            return args.pop(0)

        flags = {"a": ("utoskip",), "b": ("its",), "e": (), "u": ("ppercase",), "p": ("s", "lain", "ostscript"),
                 "i": ("nclude",), "C": ("apitalize",), "d": ("ecimal",), "r": ("evert",)}
        if letter in flags:
            if rest and rest not in flags[letter]:
                die("xxd", f"'{a}' is '-{letter}' to xxd, which ignores the rest of it; write each option separately")
            if letter == "a":
                autoskip = not autoskip
            elif letter == "b":
                hextype = "bits"
            elif letter == "e":
                hextype = "little"
            elif letter == "u":
                upper = True
            elif letter == "p":
                hextype = "ps"
            elif letter == "i":
                hextype = "include"
            elif letter == "C":
                capitalize = True
            elif letter == "d":
                decimal = True
            else:
                revert = True
        elif letter == "c":
            if rest == "apitalize":
                capitalize = True
            else:
                cols = c_number(value(("ols",)))[0] or 0
        elif letter == "g":
            group = c_number(value(("roup",)))[0] or 0
        elif letter == "o":
            display = c_number(value(("ffset",)))[0] or 0
        elif letter == "l":
            length = c_number(value(("en",)))[0] or 0
        elif letter == "n":
            varname = value(("ame",))
        elif letter == "s":
            text = value(("kip", "eek"))
            relseek = text.startswith("+")
            text = text[1:] if relseek else text
            negseek = text.startswith("-")
            seek = c_number(text[1:] if negseek else text)[0] or 0
        elif letter == "R":
            when = value(())
            if when not in ("never", "auto"):
                die("xxd", f"-R {when} is not supported here: this xxd does not colour its output")
        elif letter == "v":
            sys.stderr.write("xxd 2023-10-25 by Juergen Weigert et al.\n")
            return 0
        elif letter == "E":
            die("xxd", "unsupported option '-E': EBCDIC is not supported here")
        else:
            usage()
    if len(args) > 2:
        usage()
    infile = args[0] if args else "-"
    outfile = args[1] if len(args) > 1 else "-"

    if revert:
        if hextype == "bits":
            die("xxd", "-r -b is not supported here; -r reads the plain dump and -p")
        if hextype not in ("normal", "ps"):
            sys.stderr.write("xxd: Sorry, cannot revert this type of hexdump\n")
            return 255
    if cols is None or (cols == 0 and hextype != "ps"):
        cols = {"ps": 30, "include": 12, "bits": 6}.get(hextype, 16)
    if group is None:
        group = {"bits": 1, "normal": 2, "little": 4}.get(hextype, 0)
    if (hextype == "ps" and cols < 0) or (hextype != "ps" and cols < 1) or (
        hextype in ("normal", "bits", "little") and cols > 256
    ):
        sys.stderr.write("xxd: invalid number of columns (max. 256).\n")
        return 1
    if group < 1 or group > cols:
        group = cols
    elif hextype == "little" and group & (group - 1):
        sys.stderr.write("xxd: number of octets per group must be a power of 2 with -e.\n")
        return 1

    if infile == "-":
        source, regular = sys.stdin.buffer, stat.S_ISREG(os.fstat(0).st_mode)
    else:
        try:
            source = open(infile, "rb")
            regular = stat.S_ISREG(os.fstat(source.fileno()).st_mode)
        except IsADirectoryError as e:
            if revert:
                return 0
            die("xxd", e.strerror)
        except OSError as e:
            die("xxd", f"{infile}: {e.strerror}")
    data = source.read()

    if outfile == "-":
        sys.stdout.flush()
        fd = 1
    else:
        try:
            fd = os.open(outfile, os.O_WRONLY | os.O_CREAT | (0 if revert else os.O_TRUNC), 0o666)
        except OSError as e:
            die("xxd", f"{outfile}: {e.strerror}", 3)

    if revert:
        return xxd_revert(data, hextype, cols, -seek if negseek else seek, fd)

    seekoff = 0
    if seek or negseek or not relseek:
        if regular:
            where = (-seek if negseek else seek) + (len(data) if negseek and not relseek else 0)
            if where < 0:
                if negseek:
                    die("xxd", "Sorry, cannot seek.", 4)
                where = 0
            seekoff = where
        else:
            if negseek or len(data) < seek:
                die("xxd", "Sorry, cannot seek.", 4)
            seekoff = seek
        data = data[seekoff:]
    if length >= 0:
        data = data[:length]

    digits = "0123456789ABCDEF" if upper else "0123456789abcdef"
    out = []
    if hextype == "ps":
        left = cols
        for b in data:
            out.append(digits[b >> 4] + digits[b & 15])
            if cols > 0:
                left -= 1
                if not left:
                    out.append("\n")
                    left = cols
        if cols == 0 or left < cols:
            out.append("\n")
    elif hextype == "include":
        name = os.fsencode(varname if varname is not None else infile)
        ident = ("__" if name[:1].isdigit() else "") + "".join(
            (chr(c).upper() if capitalize else chr(c)) if chr(c).isascii() and chr(c).isalnum() else "_" for c in name
        )
        if infile != "-":
            out.append(f"unsigned char {ident}[] = {{\n")
        shape = "0X%02X" if upper else "0x%02x"
        for p, b in enumerate(data):
            out.append((", " if p % cols else ("  " if not p else ",\n  ")) + shape % b)
        if data:
            out.append("\n")
        if infile != "-":
            out.append(f"}};\nunsigned int {ident}_{'LEN' if capitalize else 'len'} = {len(data)};\n")
    else:
        out = xxd_lines(data, hextype, cols, group, digits, decimal, seekoff + display, autoskip)
    write_all(fd, "".join(out).encode())
    return 0


def xxd_lines(data, hextype, cols, group, digits, decimal, base, autoskip):
    """xxd.c's main loop: each byte put at the column xxd.c computes for it."""
    out = []
    grplen = 8 * group + 1 if hextype == "bits" else 2 * group + 1
    zero_seen, kept = 0, ""

    def xxdline(text, nz):
        # xxd.c's xxdline(): with -a, the first all-zero line is shown, a run
        # of them becomes one '*', and the last of a run is shown again.
        nonlocal zero_seen, kept
        if not nz and zero_seen == 1:
            kept = text
        if nz:
            show = True
        else:
            show = zero_seen == 0
            zero_seen += 1
        if show:
            if nz:
                if nz < 0:
                    zero_seen -= 1
                if zero_seen == 2:
                    out.append(kept)
                if zero_seen > 2:
                    out.append("*\n")
            if nz >= 0 or zero_seen > 0:
                out.append(text)
            if nz:
                zero_seen = 0

    line, last, p, nonzero, c, addrlen = [], "", 0, 0, 0, 0
    for n, e in enumerate(data):
        if p == 0:
            address = ("%08d:" if decimal else "%08x:") % (n + base)
            addrlen = len(address)
            line = list(address) + [" "] * (addrlen + 4 + grplen * cols + cols)
        x = p ^ (group - 1) if hextype == "little" else p
        c = addrlen + 1 + (grplen * x) // group
        if hextype == "bits":
            for bit in range(7, -1, -1):
                line[c] = "1" if e >> bit & 1 else "0"
                c += 1
        else:
            line[c], line[c + 1] = digits[e >> 4], digits[e & 15]
        nonzero += 1 if e else 0
        if hextype == "little":
            c = grplen * ((cols + group - 1) // group)
        else:
            c = (grplen * cols - 1) // group
        c += addrlen + 3 + p
        line[c] = chr(e) if 31 < e < 127 else "."
        c += 1
        p += 1
        if p == cols:
            last = "".join(line[:c]) + "\n"
            xxdline(last, nonzero if autoskip else 1)
            nonzero, p = 0, 0
    if p:
        xxdline("".join(line[:c]) + "\n", 1)
    elif autoskip:
        xxdline(last, -1)
    return out


def xxd_revert(data, hextype, cols, base_off, fd):
    """xxd.c's huntype(): hex back into bytes, garbage and all, as xxd reads it.

    In the plain dump each line starts with an offset, and the bytes go there;
    three characters in a row that are not hex end a line's data. With -p the
    hex is one stream, whitespace ignored. Written to a file, the file is not
    truncated — xxd -r patches it — and a gap is a seek; written to a pipe, a
    gap is zeros, and an offset going backwards is an error.
    """
    plain = hextype == "ps"
    have, want, n1, n2, n3, p, ign_garb = 0, 0, -1, 0, 0, cols, True
    pending = bytearray()

    def flush():
        if pending:
            write_all(fd, bytes(pending))
            pending.clear()

    def move(target):
        nonlocal have
        flush()
        try:
            os.lseek(fd, target - have, os.SEEK_CUR)
            have = target
            return
        except OSError:
            pass
        if target < have:
            die("xxd", "Sorry, cannot seek backwards.", 5)
        while have < target:
            step = min(target - have, 1 << 20)
            write_all(fd, bytes(step))
            have += step

    i, size = 0, len(data)

    def skip_to_eol(ch):
        nonlocal i
        while ch not in (10, -1):
            ch = data[i] if i < size else -1
            i += 1
        return ch

    while i < size:
        c = data[i]
        i += 1
        if c == 13 or (plain and c in (32, 10, 9)):
            continue
        n3, n2 = n2, n1
        n1 = int(chr(c), 16) if chr(c) in "0123456789abcdefABCDEF" else -1
        if n1 == -1 and ign_garb:
            continue
        ign_garb = False
        if not plain and p >= cols:
            if n1 < 0:
                p = 0
                continue
            want = (want << 4) | n1
            continue
        if base_off + want != have:
            move(base_off + want)
        if n2 >= 0 and n1 >= 0:
            pending.append((n2 << 4) | n1)
            have += 1
            want += 1
            n1 = -1
            if not plain:
                p += 1
                if p >= cols:
                    c = skip_to_eol(c)
        elif n1 < 0 and n2 < 0 and n3 < 0:
            c = skip_to_eol(c)
        if c == 10:
            if not plain:
                want = 0
            p = cols
            ign_garb = True
    flush()
    return 0


# ---------------------------------------------------- bzip2 / xz, via stdlib
def compressor(argv, tool, module, suffix):
    decompress, keep, to_stdout, files = tool.startswith(("bun", "un")), False, False, []
    for a in argv:
        if a.startswith("-") and a != "-":
            for flag in a[1:]:
                if flag == "d":
                    decompress = True
                elif flag == "k":
                    keep = True
                elif flag == "c":
                    to_stdout = True
                else:
                    die(tool, f"unsupported option '-{flag}'. Supported: -d -k -c")
        else:
            files.append(a)

    if not files:
        raw = sys.stdin.buffer.read()
        sys.stdout.buffer.write(module.decompress(raw) if decompress else module.compress(raw))
        return 0

    for name in files:
        try:
            with open(name, "rb") as f:
                raw = f.read()
        except OSError as e:
            die(tool, f"{name}: {e.strerror}", code=1)
        if decompress:
            out_name = name[: -len(suffix)] if name.endswith(suffix) else name + ".out"
            body = module.decompress(raw)
        else:
            out_name = name + suffix
            body = module.compress(raw)
        if to_stdout:
            sys.stdout.buffer.write(body)
            continue
        with open(out_name, "wb") as f:
            f.write(body)
        if not keep:
            os.remove(name)
    return 0


# ---------------------------------------------------------------- cal / rev
def cmd_cal(argv):
    import calendar
    import datetime

    numbers = [int(a) for a in argv if a.isdigit()]
    today = datetime.date.today()
    # Unix `cal` starts the week on Sunday; python's default is Monday.
    weeks = calendar.TextCalendar(calendar.SUNDAY)
    if len(numbers) == 2:
        month, year = numbers[0], numbers[1]
    elif len(numbers) == 1:
        print(weeks.formatyear(numbers[0]), end="")
        return 0
    else:
        month, year = today.month, today.year
    # Real cal ends with a blank line; python's formatmonth does not.
    print(weeks.formatmonth(year, month).rstrip("\n") + "\n\n", end="")
    return 0


def cmd_rev(argv):
    """util-linux rev: each file on its own, and a last line with no newline left without one.

    Lines end at a newline and at nothing else — not at the form feeds and
    carriage returns python's splitlines() also ends them at. Characters are
    reversed, not bytes, as rev does in a UTF-8 locale.
    """
    sep, files, only_files = "\n", [], False
    for a in argv:
        if only_files or not a.startswith("-") or a == "-":
            files.append(a)
        elif a == "--":
            only_files = True
        elif a in ("-0", "--zero"):
            sep = "\0"
        else:
            die("rev", f"unsupported option '{a}'. Supported: -0")
    status = 0
    for name in files or [None]:
        if name is None:
            data = sys.stdin.buffer.read()
        else:
            try:
                with open(name, "rb") as f:
                    data = f.read()
            except OSError as e:
                sys.stderr.write(f"rev: cannot open {name}: {e.strerror}\n")
                status = 1
                continue
        text = data.decode("utf-8", "surrogateescape")
        reversed_text = sep.join(line[::-1] for line in text.split(sep))
        sys.stdout.buffer.write(reversed_text.encode("utf-8", "surrogateescape"))
    return status


# ---------------------------------------------------------------- which
def cmd_which(argv):
    """debianutils which: the first match on PATH for each name, or every match with -a.

    A name with a slash in it is tested as it stands. An empty PATH entry is
    the current directory, and a match there is written `./name`, as which
    writes it. Like which, it knows nothing of aliases — the shims are aliases.
    """
    every, silent, names, i = False, False, [], 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            names = argv[i + 1 :]
            break
        if not a.startswith("-") or a == "-":
            names = argv[i:]
            break
        for f in a[1:]:
            if f == "a":
                every = True
            elif f == "s":
                silent = True
            else:
                die("which", f"unsupported option '-{f}'. Supported: -a -s")
        i += 1
    path = os.environ.get("PATH", "")
    entries = path.split(":") if path else []
    status = 0 if names else 1
    for name in names:
        found = False
        candidates = [name] if "/" in name else [f"{entry or '.'}/{name}" for entry in entries]
        for candidate in candidates:
            # shutil.which's test rather than which's `-f`: this runtime's
            # commands need not be regular files, and that test finds them.
            if os.path.exists(candidate) and not os.path.isdir(candidate) and os.access(candidate, os.X_OK):
                found = True
                if not silent:
                    print(candidate)
                if not every:
                    break
        if not found:
            status = 1
    return status


# ------------------------------------------------------------------- find
# The shipped findutils `find` works, with two faults it cannot be talked out
# of: `-exec` produces nothing and exits 1 because the binary cannot spawn, and
# every run exits 1 anyway, having done the work and then failed to restore its
# working directory under WASIX. Both are invisible until you chain something
# onto it, at which point a correct search looks like a failed one.
#
# python can spawn — that is what makes `xargs` work here — so find becomes a
# shim like the rest. The expression grammar is the part worth being careful
# about: `-o` binds looser than `-a`, `!` binds tightest, and an expression
# with no action gets an implicit `-print`, which is the whole reason
# `find . -name x` prints anything at all.
def cmd_find(argv):
    import fnmatch

    paths, i = [], 0
    while i < len(argv) and argv[i] not in ("!", "(") and not argv[i].startswith("-"):
        paths.append(argv[i])
        i += 1
    paths = paths or ["."]
    rest = argv[i:]

    mindepth, maxdepth = 0, None
    # -exec ... + batches its matches and runs once at the end, so the command
    # and the names it collected have to outlive the walk.
    batched = []

    def parse(tokens):
        """expr := term ('-o' term)* ; term := factor+ ; factor := '!' factor | '(' expr ')' | test"""
        pos = 0

        def peek():
            return tokens[pos] if pos < len(tokens) else None

        def expr():
            nonlocal pos
            node = term()
            while peek() in ("-o", "-or"):
                pos += 1
                right = term()
                node = ("or", node, right)
            return node

        def term():
            nonlocal pos
            node = None
            while True:
                t = peek()
                if t is None or t in ("-o", "-or", ")"):
                    break
                if t in ("-a", "-and"):
                    pos += 1
                    continue
                f = factor()
                node = f if node is None else ("and", node, f)
            return node if node is not None else ("true",)

        def factor():
            nonlocal pos
            t = peek()
            if t in ("!", "-not"):
                pos += 1
                return ("not", factor())
            if t == "(":
                pos += 1
                node = expr()
                if peek() != ")":
                    die("find", "expected ')'")
                pos += 1
                return node
            return test()

        def arg(name):
            # The option itself is already consumed, so the argument is sitting
            # at `pos` — advancing first would step over it.
            nonlocal pos
            if pos >= len(tokens):
                die("find", f"missing argument to '{name}'")
            value = tokens[pos]
            pos += 1
            return value

        def test():
            nonlocal pos, mindepth, maxdepth
            t = tokens[pos]
            pos += 1
            if t in ("-name", "-iname", "-path", "-ipath", "-wholename"):
                return (t[1:], arg(t))
            if t == "-type":
                return ("type", arg(t))
            if t == "-size":
                return ("size", arg(t))
            if t == "-empty":
                return ("empty",)
            if t == "-print":
                return ("print", "\n")
            if t == "-print0":
                return ("print", "\0")
            if t == "-delete":
                return ("delete",)
            if t in ("-maxdepth", "-mindepth"):
                n = int(arg(t))
                if t == "-maxdepth":
                    maxdepth = n
                else:
                    mindepth = n
                return ("true",)
            if t == "-exec":
                cmd = []
                while pos < len(tokens) and tokens[pos] not in (";", "+"):
                    cmd.append(tokens[pos])
                    pos += 1
                if pos >= len(tokens):
                    die("find", "-exec needs a terminating ';' or '+'")
                end = tokens[pos]
                pos += 1
                if end == "+":
                    batched.append([cmd, []])
                    return ("execplus", len(batched) - 1)
                return ("exec", cmd)
            die("find", f"unsupported expression '{t}'")

        node = expr()
        if pos != len(tokens):
            die("find", f"unexpected '{tokens[pos]}'")
        return node

    tree = parse(rest)

    def has_action(node):
        if node[0] in ("print", "delete", "exec", "execplus"):
            return True
        if node[0] in ("and", "or"):
            return has_action(node[1]) or has_action(node[2])
        if node[0] == "not":
            return has_action(node[1])
        return False

    printing = not has_action(tree)
    status = 0

    def spawn(line):
        """Run one -exec command, and say something useful when it is not there.

        The commands reachable here are real binaries only. Every tool this file
        provides is a shell alias, and a spawned process does not inherit those
        — so `-exec tree {} \\;` cannot work however much it looks like it
        should. Without this it surfaced as a python traceback.
        """
        nonlocal status
        try:
            return subprocess.run(line).returncode
        except FileNotFoundError:
            sys.stderr.write(
                f"find: '{line[0]}': No such file or directory\n"
                f"find: -exec runs real programs, and cannot see shell aliases\n"
            )
            status = 1
            return 1

    def size_matches(spec, nbytes):
        units = {"b": 512, "c": 1, "w": 2, "k": 1024, "M": 1024 ** 2, "G": 1024 ** 3}
        sign = ""
        if spec and spec[0] in "+-":
            sign, spec = spec[0], spec[1:]
        unit = "b"
        if spec and spec[-1] in units:
            unit, spec = spec[-1], spec[:-1]
        want = int(spec)
        # GNU rounds up to the next whole unit, so a 3-byte file is 1k — which
        # is why `-size -1k` finds nothing rather than everything small.
        size = -(-nbytes // units[unit])
        return size > want if sign == "+" else size < want if sign == "-" else size == want

    def evaluate(node, path, st):
        nonlocal status
        kind = node[0]
        if kind == "true":
            return True
        if kind == "and":
            return evaluate(node[1], path, st) and evaluate(node[2], path, st)
        if kind == "or":
            return evaluate(node[1], path, st) or evaluate(node[2], path, st)
        if kind == "not":
            return not evaluate(node[1], path, st)
        if kind in ("name", "iname"):
            base = os.path.basename(path)
            return fnmatch.fnmatch(base.lower(), node[1].lower()) if kind == "iname" else fnmatch.fnmatchcase(base, node[1])
        if kind in ("path", "ipath", "wholename"):
            return fnmatch.fnmatch(path.lower(), node[1].lower()) if kind == "ipath" else fnmatch.fnmatchcase(path, node[1])
        if kind == "type":
            want = node[1]
            if want == "f":
                return stat.S_ISREG(st.st_mode)
            if want == "d":
                return stat.S_ISDIR(st.st_mode)
            if want == "l":
                return stat.S_ISLNK(st.st_mode)
            die("find", f"unsupported -type '{want}'")
        if kind == "size":
            return stat.S_ISREG(st.st_mode) and size_matches(node[1], st.st_size)
        if kind == "empty":
            if stat.S_ISDIR(st.st_mode):
                try:
                    return not os.listdir(path)
                except OSError:
                    return False
            return st.st_size == 0
        if kind == "print":
            sys.stdout.write(path + node[1])
            return True
        if kind == "delete":
            try:
                os.rmdir(path) if stat.S_ISDIR(st.st_mode) else os.remove(path)
            except OSError as e:
                sys.stderr.write(f"find: cannot delete '{path}': {e.strerror}\n")
                status = 1
                return False
            return True
        if kind == "exec":
            line = [path if a == "{}" else a.replace("{}", path) for a in node[1]]
            return spawn(line) == 0
        if kind == "execplus":
            batched[node[1]][1].append(path)
            return True
        return False

    # The shims live in the folder so the shell can reach them, and they are
    # emphatically not part of anybody's folder — sync.ts says the same thing
    # in the same words and refuses to publish them. The file tree hides them
    # and `ls` hides them, being a dotfile; a search should not be the one
    # place five files nobody wrote turn up. `find .ajar` still works if you
    # name it, exactly as a hidden directory should.
    HIDDEN = ".ajar"

    def walk(root, depth):
        nonlocal status
        if depth > 0 and os.path.basename(root) == HIDDEN:
            return
        try:
            st = os.lstat(root)
        except OSError as e:
            sys.stderr.write(f"find: '{root}': {e.strerror}\n")
            status = 1
            return
        if depth >= mindepth and (maxdepth is None or depth <= maxdepth):
            matched = evaluate(tree, root, st)
            if printing and matched:
                sys.stdout.write(root + "\n")
        if stat.S_ISDIR(st.st_mode) and (maxdepth is None or depth < maxdepth):
            try:
                names = sorted(os.listdir(root))
            except OSError as e:
                sys.stderr.write(f"find: '{root}': {e.strerror}\n")
                status = 1
                return
            for name in names:
                walk(os.path.join(root, name), depth + 1)

    for p in paths:
        walk(p, 0)

    for cmd, names in batched:
        if not names:
            continue
        line = [a for a in cmd if a != "{}"] + names
        if spawn(line) != 0:
            status = 1

    return status


COMMANDS = {
    "diff": cmd_diff,
    "tree": cmd_tree,
    "du": cmd_du,
    "stat": cmd_stat,
    "split": cmd_split,
    "xargs": cmd_xargs,
    "find": cmd_find,
    "zip": cmd_zip,
    "unzip": cmd_unzip,
    "sha256sum": lambda a: cmd_sum(a, "sha256"),
    "md5sum": lambda a: cmd_sum(a, "md5"),
    "sha1sum": lambda a: cmd_sum(a, "sha1"),
    "patch": cmd_patch,
    "cmp": cmp_files,
    "hexdump": cmd_hexdump,
    "xxd": cmd_xxd,
    "cal": cmd_cal,
    "rev": cmd_rev,
    "which": cmd_which,
    "bzip2": lambda a: compressor(a, "bzip2", __import__("bz2"), ".bz2"),
    "bunzip2": lambda a: compressor(a, "bunzip2", __import__("bz2"), ".bz2"),
    "xz": lambda a: compressor(a, "xz", __import__("lzma"), ".xz"),
    "unxz": lambda a: compressor(a, "unxz", __import__("lzma"), ".xz"),
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.stderr.write(f"usage: box.py <{'|'.join(sorted(COMMANDS))}> [args...]\n")
        raise SystemExit(2)
    try:
        code = COMMANDS[sys.argv[1]](sys.argv[2:]) or 0
        sys.stdout.flush()
    except BrokenPipeError:
        # The reader went — `| head` — which a real tool is told by SIGPIPE and
        # dies of quietly. Python flushes once more on its way out, and that
        # flush meeting the closed pipe printed "Exception ignored ...
        # BrokenPipeError" over the terminal; pointed at /dev/null it says nothing.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        code = 0
    raise SystemExit(code)
