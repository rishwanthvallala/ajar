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
    show_all, dirs_only, roots = False, False, []
    for a in argv:
        if a == "-a":
            show_all = True
        elif a == "-d":
            dirs_only = True
        elif a.startswith("-"):
            die("tree", f"unsupported option '{a}'. Supported: -a -d")
        else:
            roots.append(a)
    roots = roots or ["."]
    files = dirs = 0

    def walk(path, prefix):
        nonlocal files, dirs
        try:
            names = sorted(os.listdir(path))
        except OSError as e:
            sys.stderr.write(f"tree: {path}: {e.strerror}\n")
            return
        if not show_all:
            names = [n for n in names if not n.startswith(".")]
        entries = [(n, os.path.isdir(os.path.join(path, n))) for n in names]
        if dirs_only:
            entries = [e for e in entries if e[1]]
        for index, (name, is_dir) in enumerate(entries):
            last = index == len(entries) - 1
            print(f"{prefix}{'└── ' if last else '├── '}{name}")
            if is_dir:
                dirs += 1
                walk(os.path.join(path, name), prefix + ("    " if last else "│   "))
            else:
                files += 1

    for root in roots:
        print(root)
        walk(root, "")
    print(f"\n{dirs} director{'y' if dirs == 1 else 'ies'}, {files} file{'' if files == 1 else 's'}")
    return 0


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
def cmd_du(argv):
    summarise, human, all_files, paths = False, False, False, []
    for a in argv:
        if a.startswith("-") and a != "-":
            for flag in a[1:]:
                if flag == "s":
                    summarise = True
                elif flag == "h":
                    human = True
                elif flag == "a":
                    all_files = True
                else:
                    die("du", f"unsupported option '-{flag}'. Supported: -s -h -a")
        else:
            paths.append(a)

    def show(size, name):
        if human:
            value = float(size)
            for unit in ("", "K", "M", "G"):
                if value < 1024 or unit == "G":
                    print(f"{value:.0f}{unit}\t{name}" if unit else f"{value:.0f}\t{name}")
                    return
                value /= 1024
        else:
            print(f"{(size + 1023) // 1024}\t{name}")

    for path in paths or ["."]:
        if os.path.isfile(path):
            show(os.path.getsize(path), path)
            continue
        total = 0
        for root, _, names in os.walk(path):
            for name in names:
                full = os.path.join(root, name)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    continue
                total += size
                if all_files:
                    show(size, full)
        show(total, path)
    return 0


# ---------------------------------------------------------------- stat
def cmd_stat(argv):
    fmt, files = None, []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-c", "--format"):
            i += 1
            fmt = argv[i]
        elif a.startswith("--format="):
            fmt = a.split("=", 1)[1]
        elif a.startswith("-") and a != "-":
            die("stat", f"unsupported option '{a}'. Supported: -c FORMAT")
        else:
            files.append(a)
        i += 1
    if not files:
        die("stat", "needs a file")
    for name in files:
        try:
            info = os.stat(name)
        except OSError as e:
            die("stat", f"cannot stat '{name}': {e.strerror}", code=1)
        kind = "directory" if os.path.isdir(name) else "regular file"
        if fmt:
            print(
                fmt.replace("%n", name)
                .replace("%s", str(info.st_size))
                .replace("%F", kind)
                .replace("%f", oct(info.st_mode)[2:])
                .replace("%a", oct(info.st_mode & 0o777)[2:])
            )
        else:
            print(f"  File: {name}\n  Size: {info.st_size}\t{kind}")
    return 0


# ---------------------------------------------------------------- split
def cmd_split(argv):
    lines, size, prefix, files = 1000, None, "x", []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("-l"):
            lines = int(a[2:] or argv[(i := i + 1)])
            size = None
        elif a.startswith("-b"):
            size = int(a[2:] or argv[(i := i + 1)])
        elif a.startswith("-") and a != "-":
            die("split", f"unsupported option '{a}'. Supported: -l N -b N")
        else:
            files.append(a)
        i += 1
    source = files[0] if files else "-"
    if len(files) > 1:
        prefix = files[1]

    def name_for(index):
        return f"{prefix}{chr(97 + index // 26)}{chr(97 + index % 26)}"

    text = read_text(source, "split")
    chunks = []
    if size is not None:
        chunks = [text[i : i + size] for i in range(0, len(text), size)] or [""]
    else:
        rows = text.splitlines(keepends=True)
        chunks = ["".join(rows[i : i + lines]) for i in range(0, len(rows), lines)] or [""]
    for index, chunk in enumerate(chunks):
        with open(name_for(index), "w", errors="surrogateescape") as f:
            f.write(chunk)
    return 0


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
