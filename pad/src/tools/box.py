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


COMMANDS = {
    "diff": cmd_diff,
    "tree": cmd_tree,
    "du": cmd_du,
    "stat": cmd_stat,
    "split": cmd_split,
    "xargs": cmd_xargs,
    "zip": cmd_zip,
    "unzip": cmd_unzip,
    "sha256sum": lambda a: cmd_sum(a, "sha256"),
    "md5sum": lambda a: cmd_sum(a, "md5"),
    "sha1sum": lambda a: cmd_sum(a, "sha1"),
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.stderr.write(f"usage: box.py <{'|'.join(sorted(COMMANDS))}> [args...]\n")
        raise SystemExit(2)
    raise SystemExit(COMMANDS[sys.argv[1]](sys.argv[2:]) or 0)
