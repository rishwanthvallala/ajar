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


# ------------------------------------- shared by diff, cmp, patch, xargs, find
def _getopt_long(tool, argv, shortopts, longopts, code=2, prefix_try=True):
    """GNU getopt_long, the way these tools read their arguments.

    Clustered short options (`-ruN`), an argument attached or separate
    (`-U1`, `-U 1`), `--name=value`, any unambiguous abbreviation of a long
    name, and options after operands unless `shortopts` starts with '+'.
    `longopts` maps a name to (has_arg, key): 0 none, 1 required, 2 optional.
    Returns (options as (key, value) in order, operands, the option words).
    """
    def bad(message):
        sys.stderr.write(f"{tool}: {message}\n")
        sys.stderr.write(f"{tool + ': ' if prefix_try else ''}Try '{tool} --help' for more information.\n")
        raise SystemExit(code)

    permute = not shortopts.startswith("+")
    shorts, k = {}, 0
    while k < len(shortopts):
        c, k = shortopts[k], k + 1
        if c == "+":
            continue
        n = 0
        while k < len(shortopts) and shortopts[k] == ":":
            n, k = n + 1, k + 1
        shorts[c] = n
    options, operands, words = [], [], []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            words.append(a)
            operands.extend(argv[i + 1 :])
            break
        if a.startswith("--"):
            name, eq, value = a[2:].partition("=")
            found = [n for n in longopts if n == name] or [n for n in longopts if n.startswith(name)]
            if not found:
                bad(f"unrecognized option '--{name}'")
            if len({longopts[n] for n in found}) > 1:
                bad(f"option '{a}' is ambiguous; possibilities:" + "".join(f" '--{n}'" for n in found))
            has, key = longopts[found[0]]
            words.append(a)
            if has == 0 and eq:
                bad(f"option '--{found[0]}' doesn't allow an argument")
            if has == 1 and not eq:
                if i + 1 >= len(argv):
                    bad(f"option '--{found[0]}' requires an argument")
                i += 1
                value = argv[i]
                words.append(value)
            options.append((key, value if (eq or has == 1) else None))
        elif a.startswith("-") and a != "-":
            words.append(a)
            j = 1
            while j < len(a):
                c, j = a[j], j + 1
                if c not in shorts:
                    bad(f"invalid option -- '{c}'")
                if shorts[c] == 0:
                    options.append((c, None))
                    continue
                if j < len(a):
                    options.append((c, a[j:]))
                elif shorts[c] == 2:
                    options.append((c, None))
                elif i + 1 >= len(argv):
                    bad(f"option requires an argument -- '{c}'")
                else:
                    i += 1
                    options.append((c, argv[i]))
                    words.append(argv[i])
                break
        elif permute:
            operands.append(a)
        else:
            operands.extend(argv[i:])
            break
        i += 1
    return options, operands, words


def _shell_quote(word):
    """A word as a shell would need it typed: bare when that is safe."""
    safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789%+,-./:=@_"
    if word and all(c in safe for c in word):
        return word
    return "'" + word.replace("'", "'\\''") + "'"


def _c_locale(category):
    """True when LC_ALL / the category / LANG leave the tool in the C locale.

    GNU picks some wordings by this ("char" against "byte" in cmp, the date
    in a context diff's header), so the shims ask the same question.
    """
    for var in ("LC_ALL", category, "LANG"):
        value = os.environ.get(var)
        if value:
            return value in ("C", "POSIX")
    return True


def _fnmatch_re(pattern, icase=False, pathname=False):
    """A shell glob as GNU fnmatch reads it, compiled for bytes.

    Python's fnmatch takes a backslash literally, does not know `[^...]` or
    `[[:digit:]]`, and so answers some patterns differently from the real
    find and diff.
    """
    import re

    classes = {"alpha": "A-Za-z", "digit": "0-9", "alnum": "A-Za-z0-9", "upper": "A-Z", "lower": "a-z",
               "space": " \\t\\n\\r\\f\\v", "blank": " \\t", "punct": "!-/:-@\\[-`{-~", "print": " -~",
               "graph": "!-~", "cntrl": "\\x00-\\x1f\\x7f", "xdigit": "0-9A-Fa-f"}
    p = os.fsencode(pattern).decode("latin-1")
    out, i, n = [], 0, len(p)
    star = "[^/]*" if pathname else ".*"
    while i < n:
        c = p[i]
        i += 1
        if c == "*":
            out.append(star)
        elif c == "?":
            out.append("[^/]" if pathname else ".")
        elif c == "\\" and i < n:
            out.append(re.escape(p[i]))
            i += 1
        elif c == "[":
            j, neg, items, first = i, False, [], True
            if j < n and p[j] in "!^":
                neg, j = True, j + 1
            closed = False
            while j < n:
                ch = p[j]
                if ch == "]" and not first:
                    closed = True
                    j += 1
                    break
                first = False
                if ch == "[" and j + 1 < n and p[j + 1] == ":":
                    end = p.find(":]", j + 2)
                    if end > 0 and p[j + 2 : end] in classes:
                        items.append(classes[p[j + 2 : end]])
                        j = end + 2
                        continue
                if ch == "\\" and j + 1 < n:
                    j += 1
                    ch = p[j]
                if j + 2 < n and p[j + 1] == "-" and p[j + 2] != "]":
                    hi = p[j + 2]
                    if ord(ch) <= ord(hi):
                        items.append(re.escape(ch) + "-" + re.escape(hi))
                    j += 3
                    continue
                items.append(re.escape(ch))
                j += 1
            if closed and items:
                out.append(("[^" if neg else "[") + "".join(items) + "]")
                i = j
            else:
                out.append("\\[")
        else:
            out.append(re.escape(c))
    flags = re.DOTALL | (re.IGNORECASE if icase else 0)
    return re.compile("".join(out).encode("latin-1") + b"\\Z", flags)


def _gnu_regex(pattern, syntax, icase=False):
    """A GNU regular expression in one of its syntaxes, as a Python bytes pattern.

    `emacs` is what find uses by default: \\( \\) \\| for groups and
    alternation, + and ? as operators, and no character classes or
    intervals. `basic` is POSIX BRE with GNU's \\+ \\? \\|, as grep and diff -I
    read it; `extended` is ERE. Only whether something matches is ever
    asked of it, which is the same question under Python's backtracking as
    under POSIX's leftmost-longest rule.
    """
    import re

    if syntax not in ("emacs", "basic", "extended"):
        raise ValueError(syntax)
    ext, emacs = syntax == "extended", syntax == "emacs"
    classes = {"alpha": "A-Za-z", "digit": "0-9", "alnum": "A-Za-z0-9", "upper": "A-Z", "lower": "a-z",
               "space": " \\t\\n\\r\\f\\v", "blank": " \\t", "punct": "!-/:-@\\[-`{-~", "print": " -~",
               "graph": "!-~", "cntrl": "\\x00-\\x1f\\x7f", "xdigit": "0-9A-Fa-f"}
    p = os.fsencode(pattern).decode("latin-1")
    n = len(p)
    out = []          # tokens; an atom and its quantifier stay separate so they can be wrapped
    kinds = []        # 'open', 'alt', 'start', 'atom', 'quant', 'anchor'
    depth = 0

    def last_atom_start():
        # Index in `out` where the atom the next quantifier applies to begins.
        k, level = len(out) - 1, 0
        while kinds[k] == "quant":
            k -= 1
        if out[k] == ")":
            while True:
                if out[k] == ")":
                    level += 1
                elif out[k] in ("(", "(?:"):
                    level -= 1
                    if level == 0:
                        return k
                k -= 1
        return k

    def quantify(q):
        if kinds and kinds[-1] == "quant":
            k = last_atom_start()
            out[k:] = ["(?:" + "".join(out[k:]) + ")"]
            kinds[k:] = ["atom"]
        out.append(q)
        kinds.append("quant")

    def context_start():
        return not kinds or kinds[-1] in ("open", "alt", "start")

    i = 0
    while i < n:
        c = p[i]
        i += 1
        if c == "\\":
            if i >= n:
                raise re.error("Trailing backslash")
            c = p[i]
            i += 1
            if not ext and c == "(":
                out.append("(")
                kinds.append("open")
                depth += 1
            elif not ext and c == ")":
                if not depth:
                    raise re.error("Unmatched ) or \\)")
                depth -= 1
                out.append(")")
                kinds.append("atom")
            elif not ext and c == "|":
                out.append("|")
                kinds.append("alt")
            elif syntax == "basic" and c in "+?":
                if context_start():
                    out.append(re.escape(c))
                    kinds.append("atom")
                else:
                    quantify(c)
            elif syntax == "basic" and c == "{":
                end = p.find("\\}", i)
                body = p[i:end] if end >= 0 else ""
                if end < 0 or not re.fullmatch(r"\d*(,\d*)?", body) or body in ("", ","):
                    raise re.error("Invalid content of \\{\\}")
                quantify("{" + body + "}")
                i = end + 2
            elif c in "123456789":
                out.append("\\" + c)
                kinds.append("atom")
            elif c in "wWsSbB":
                out.append({"w": "[A-Za-z0-9_]", "W": "[^A-Za-z0-9_]", "s": "[ \\t\\n\\r\\f\\v]",
                            "S": "[^ \\t\\n\\r\\f\\v]", "b": "\\b", "B": "\\B"}[c])
                kinds.append("atom" if c in "wWsS" else "anchor")
            elif c == "<":
                out.append("\\b(?=\\w)")
                kinds.append("anchor")
            elif c == ">":
                out.append("\\b(?<=\\w)")
                kinds.append("anchor")
            elif c == "`":
                out.append("\\A")
                kinds.append("start")
            elif c == "'":
                out.append("\\Z")
                kinds.append("anchor")
            else:
                out.append(re.escape(c))
                kinds.append("atom")
        elif ext and c == "(":
            out.append("(")
            kinds.append("open")
            depth += 1
        elif ext and c == ")" and depth:
            depth -= 1
            out.append(")")
            kinds.append("atom")
        elif ext and c == "|":
            out.append("|")
            kinds.append("alt")
        elif c == "^" and (ext or context_start()):
            out.append("^")
            kinds.append("start")
        elif c == "$" and (ext or i == n or p.startswith("\\)", i) or p.startswith("\\|", i)):
            out.append("\\Z")
            kinds.append("anchor")
        elif c == "*" or (c in "+?" and syntax != "basic"):
            if context_start():
                if ext:
                    raise re.error("Invalid preceding regular expression")
                out.append(re.escape(c))
                kinds.append("atom")
            else:
                quantify(c)
        elif ext and c == "{" and not context_start() and re.match(r"\d*(,\d*)?\}", p[i:]) and p[i] != "}":
            end = p.index("}", i)
            quantify("{" + p[i:end] + "}")
            i = end + 1
        elif c == ".":
            out.append(".")
            kinds.append("atom")
        elif c == "[":
            j, neg, items, first = i, False, [], True
            if j < n and p[j] == "^":
                neg, j = True, j + 1
            while True:
                if j >= n:
                    raise re.error("Unmatched [, [^, [:, [., or [=")
                ch = p[j]
                if ch == "]" and not first:
                    j += 1
                    break
                first = False
                if not emacs and ch == "[" and j + 1 < n and p[j + 1] in ":=.":
                    kind = p[j + 1]
                    end = p.find(kind + "]", j + 2)
                    if end < 0:
                        raise re.error("Unmatched [, [^, [:, [., or [=")
                    name = p[j + 2 : end]
                    if kind == ":":
                        if name not in classes:
                            raise re.error("Invalid character class name")
                        items.append(classes[name])
                    else:
                        items.append(re.escape(name))
                    j = end + 2
                    continue
                if j + 2 < n and p[j + 1] == "-" and p[j + 2] != "]":
                    hi = p[j + 2]
                    if ord(ch) <= ord(hi):
                        items.append(re.escape(ch) + "-" + re.escape(hi))
                    elif not emacs:
                        raise re.error("Invalid range end")
                    j += 3
                    continue
                items.append(re.escape(ch))
                j += 1
            out.append(("[^" if neg else "[") + "".join(items) + "]" if items else ("." if neg else "(?!)"))
            kinds.append("atom")
            i = j
        else:
            out.append(re.escape(c))
            kinds.append("atom")
    if depth:
        raise re.error("Unmatched ( or \\(")
    flags = re.DOTALL | (re.IGNORECASE if icase else 0)
    return re.compile("".join(out).encode("latin-1"), flags)


# ---------------------------------------------------------------- diff
#
# A port of GNU diffutils 3.10's diff rather than a resemblance of it: the
# same analysis — lines no other line matches set aside first, Myers' middle
# snake on the rest, then GNU's sliding of each change to where it reads
# best — so the hunks come out where GNU puts them, in the formats it prints,
# with "\ No newline at end of file" where a file stops short. difflib was
# here before: it pairs lines its own way, printed only unified output, and
# without the marker its diffs of such files could not be applied by
# anybody's patch.

def _diff_lines(data):
    parts = data.split(b"\n")
    lines = [part + b"\n" for part in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def _diff_script(a, b, key, horizon, minimal, heuristic):
    """The changes between line lists `a` and `b`, as GNU diff finds them.

    `key(line, incomplete)` gives the equivalence of a line under the
    --ignore options. Returns (line0, line1, deleted, inserted) per change,
    0-based, in order.
    """
    n0, n1 = len(a), len(b)
    # The identical prefix and suffix are set aside, less `horizon` lines,
    # exactly as find_identical_ends does — it decides which lines the
    # discarding below counts, and so which of several equal diffs comes out.
    k, m = 0, min(n0, n1)
    while k < m and a[k] == b[k]:
        k += 1
    prefix = max(0, k - horizon)
    suffix = 0
    if (n0 and not a[-1].endswith(b"\n")) == (n1 and not b[-1].endswith(b"\n")):
        s, limit = 0, m - prefix
        while s < limit and a[n0 - 1 - s] == b[n1 - 1 - s]:
            s += 1
        suffix = max(0, s - horizon)
    body = (a[prefix : n0 - suffix], b[prefix : n1 - suffix])
    classes = {}
    equivs = []
    for f, lines in enumerate(body):
        # Only a file's last line can lack its newline, and it is in the body
        # only when no identical suffix was set aside.
        incomplete_at = len(lines) - 1 if suffix == 0 and lines and not lines[-1].endswith(b"\n") else -1
        equivs.append([classes.setdefault(key(line, i == incomplete_at), len(classes) + 1) for i, line in enumerate(lines)])
    len0, len1 = len(equivs[0]), len(equivs[1])
    changed = [bytearray(len0 + 2), bytearray(len1 + 2)]   # index i+1 holds line i; the ends stay 0

    # discard_confusing_lines
    counts = [{}, {}]
    for f in (0, 1):
        for e in equivs[f]:
            counts[f][e] = counts[f].get(e, 0) + 1
    discards = []
    for f in (0, 1):
        end = len(equivs[f])
        other = counts[1 - f]
        many, tem = 5, end // 64
        while True:
            tem >>= 2
            if tem <= 0:
                break
            many *= 2
        d = bytearray(end)
        for i, e in enumerate(equivs[f]):
            nmatch = other.get(e, 0)
            if nmatch == 0:
                d[i] = 1
            elif nmatch > many:
                d[i] = 2
        discards.append(d)
    for f in (0, 1):
        d = discards[f]
        end = len(d)
        i = 0
        while i < end:
            if d[i] == 2:
                d[i] = 0
            elif d[i] != 0:
                provisional, j = 0, i
                while j < end:
                    if d[j] == 0:
                        break
                    if d[j] == 2:
                        provisional += 1
                    j += 1
                while j > i and d[j - 1] == 2:
                    j -= 1
                    d[j] = 0
                    provisional -= 1
                length = j - i
                if provisional * 4 > length:
                    while j > i:
                        j -= 1
                        if d[j] == 2:
                            d[j] = 0
                else:
                    minimum, tem = 1, length >> 2
                    while True:
                        tem >>= 2
                        if tem <= 0:
                            break
                        minimum <<= 1
                    minimum += 1
                    j = consec = 0
                    while j < length:
                        if d[i + j] != 2:
                            consec = 0
                        else:
                            consec += 1
                            if minimum == consec:
                                j -= consec
                            elif minimum < consec:
                                d[i + j] = 0
                        j += 1
                    j = consec = 0
                    while j < length:
                        if j >= 8 and d[i + j] == 1:
                            break
                        if d[i + j] == 2:
                            consec = 0
                            d[i + j] = 0
                        elif d[i + j] == 0:
                            consec = 0
                        else:
                            consec += 1
                        if consec == 3:
                            break
                        j += 1
                    i += length - 1
                    j = consec = 0
                    while j < length:
                        if j >= 8 and d[i - j] == 1:
                            break
                        if d[i - j] == 2:
                            consec = 0
                            d[i - j] = 0
                        elif d[i - j] == 0:
                            consec = 0
                        else:
                            consec += 1
                        if consec == 3:
                            break
                        j += 1
            i += 1
    xv, yv, real = [], [], ([], [])
    for f, vec in ((0, xv), (1, yv)):
        for i, e in enumerate(equivs[f]):
            if minimal or discards[f][i] == 0:
                vec.append(e)
                real[f].append(i)
            else:
                changed[f][i + 1] = 1

    # compareseq / diag, from gnulib's diffseq.h
    nx, ny = len(xv), len(yv)
    off = ny + 1
    fd = [0] * (nx + ny + 3)
    bd = [0] * (nx + ny + 3)
    too_expensive, t = 1, nx + ny + 3
    while t:
        too_expensive <<= 1
        t >>= 2
    too_expensive = max(4096, too_expensive)
    SNAKE, BIG = 20, 1 << 62

    def diag(xoff, xlim, yoff, ylim, find_minimal):
        dmin, dmax = xoff - ylim, xlim - yoff
        fmid, bmid = xoff - yoff, xlim - ylim
        fmin = fmax = fmid
        bmin = bmax = bmid
        odd = (fmid - bmid) & 1
        fd[fmid + off] = xoff
        bd[bmid + off] = xlim
        c = 0
        while True:
            c += 1
            big_snake = False
            if fmin > dmin:
                fmin -= 1
                fd[fmin - 1 + off] = -1
            else:
                fmin += 1
            if fmax < dmax:
                fmax += 1
                fd[fmax + 1 + off] = -1
            else:
                fmax -= 1
            for d in range(fmax, fmin - 1, -2):
                tlo, thi = fd[d - 1 + off], fd[d + 1 + off]
                x0 = thi if tlo < thi else tlo + 1
                x, y = x0, x0 - d
                while x < xlim and y < ylim and xv[x] == yv[y]:
                    x += 1
                    y += 1
                if x - x0 > SNAKE:
                    big_snake = True
                fd[d + off] = x
                if odd and bmin <= d <= bmax and bd[d + off] <= x:
                    return x, y, True, True
            if bmin > dmin:
                bmin -= 1
                bd[bmin - 1 + off] = BIG
            else:
                bmin += 1
            if bmax < dmax:
                bmax += 1
                bd[bmax + 1 + off] = BIG
            else:
                bmax -= 1
            for d in range(bmax, bmin - 1, -2):
                tlo, thi = bd[d - 1 + off], bd[d + 1 + off]
                x0 = tlo if tlo < thi else thi - 1
                x, y = x0, x0 - d
                while xoff < x and yoff < y and xv[x - 1] == yv[y - 1]:
                    x -= 1
                    y -= 1
                if x0 - x > SNAKE:
                    big_snake = True
                bd[d + off] = x
                if not odd and fmin <= d <= fmax and x <= fd[d + off]:
                    return x, y, True, True
            if find_minimal:
                continue
            if 200 < c and big_snake and heuristic:
                best = 0
                for d in range(fmax, fmin - 1, -2):
                    dd = d - fmid
                    x = fd[d + off]
                    y = x - d
                    v = (x - xoff) * 2 - dd
                    if v > 12 * (c + abs(dd)) and v > best and xoff + SNAKE <= x < xlim and yoff + SNAKE <= y < ylim:
                        k = 1
                        while xv[x - k] == yv[y - k]:
                            if k == SNAKE:
                                best, part = v, (x, y)
                                break
                            k += 1
                if best > 0:
                    return part[0], part[1], True, False
                best = 0
                for d in range(bmax, bmin - 1, -2):
                    dd = d - bmid
                    x = bd[d + off]
                    y = x - d
                    v = (xlim - x) * 2 + dd
                    if v > 12 * (c + abs(dd)) and v > best and xoff < x <= xlim - SNAKE and yoff < y <= ylim - SNAKE:
                        k = 0
                        while xv[x + k] == yv[y + k]:
                            if k == SNAKE - 1:
                                best, part = v, (x, y)
                                break
                            k += 1
                if best > 0:
                    return part[0], part[1], False, True
            if c >= too_expensive:
                fxybest, fxbest = -1, 0
                for d in range(fmax, fmin - 1, -2):
                    x = min(fd[d + off], xlim)
                    y = x - d
                    if ylim < y:
                        x, y = ylim + d, ylim
                    if fxybest < x + y:
                        fxybest, fxbest = x + y, x
                bxybest, bxbest = BIG, 0
                for d in range(bmax, bmin - 1, -2):
                    x = max(xoff, bd[d + off])
                    y = x - d
                    if y < yoff:
                        x, y = yoff + d, yoff
                    if x + y < bxybest:
                        bxybest, bxbest = x + y, x
                if (xlim + ylim) - bxybest < fxybest - (xoff + yoff):
                    return fxbest, fxybest - fxbest, True, False
                return bxbest, bxybest - bxbest, False, True

    def compareseq(xoff, xlim, yoff, ylim, find_minimal):
        while True:
            while xoff < xlim and yoff < ylim and xv[xoff] == yv[yoff]:
                xoff += 1
                yoff += 1
            while xoff < xlim and yoff < ylim and xv[xlim - 1] == yv[ylim - 1]:
                xlim -= 1
                ylim -= 1
            if xoff == xlim:
                for y in range(yoff, ylim):
                    changed[1][real[1][y] + 1] = 1
                return
            if yoff == ylim:
                for x in range(xoff, xlim):
                    changed[0][real[0][x] + 1] = 1
                return
            xmid, ymid, lo_minimal, hi_minimal = diag(xoff, xlim, yoff, ylim, find_minimal)
            if (xlim + ylim) - (xmid + ymid) < (xmid + ymid) - (xoff + yoff):
                compareseq(xmid, xlim, ymid, ylim, hi_minimal)
                xlim, ylim, find_minimal = xmid, ymid, lo_minimal
            else:
                compareseq(xoff, xmid, yoff, ymid, lo_minimal)
                xoff, yoff, find_minimal = xmid, ymid, hi_minimal

    compareseq(0, nx, 0, ny, minimal)

    # shift_boundaries: slide each run of changes to join its neighbours, and
    # otherwise as far down as it will go.
    for f in (0, 1):
        ch, oc, eq = changed[f], changed[1 - f], equivs[f]
        i = j = 0
        i_end = len(eq)
        while True:
            while i < i_end and not ch[i + 1]:
                while True:
                    j += 1
                    if not oc[j]:
                        break
                i += 1
            if i == i_end:
                break
            start = i
            i += 1
            while ch[i + 1]:
                i += 1
            while oc[j + 1]:
                j += 1
            while True:
                runlength = i - start
                while start and eq[start - 1] == eq[i - 1]:
                    start -= 1
                    ch[start + 1] = 1
                    i -= 1
                    ch[i + 1] = 0
                    while ch[start]:
                        start -= 1
                    while True:
                        j -= 1
                        if not oc[j + 1]:
                            break
                corresponding = i if oc[j] else i_end
                while i != i_end and eq[start] == eq[i]:
                    ch[start + 1] = 0
                    start += 1
                    ch[i + 1] = 1
                    i += 1
                    while ch[i + 1]:
                        i += 1
                    while True:
                        j += 1
                        if not oc[j + 1]:
                            break
                        corresponding = i
                if runlength == i - start:
                    break
            while corresponding < i:
                start -= 1
                ch[start + 1] = 1
                i -= 1
                ch[i + 1] = 0
                while True:
                    j -= 1
                    if not oc[j + 1]:
                        break

    # build_script
    script = []
    c0, c1 = changed
    i0, i1 = len0, len1
    while i0 >= 0 or i1 >= 0:
        if c0[i0] or c1[i1]:
            line0, line1 = i0, i1
            while c0[i0]:
                i0 -= 1
            while c1[i1]:
                i1 -= 1
            script.append((i0 + prefix, i1 + prefix, line0 - i0, line1 - i1))
        i0 -= 1
        i1 -= 1
    script.reverse()
    return script


def cmd_diff(argv):
    import errno
    import re
    import time

    L = {"binary": (0, "binary"), "brief": (0, "q"), "changed-group-format": (1, "formats"), "color": (2, "color"),
         "context": (2, "C"), "ed": (0, "e"), "exclude": (1, "x"), "exclude-from": (1, "X"),
         "expand-tabs": (0, "t"), "forward-ed": (0, "f"), "from-file": (1, "from-file"), "help": (0, "help"),
         "horizon-lines": (1, "horizon"), "ifdef": (1, "D"), "ignore-all-space": (0, "w"),
         "ignore-blank-lines": (0, "B"), "ignore-case": (0, "i"), "ignore-file-name-case": (0, "name-case"),
         "ignore-matching-lines": (1, "I"), "ignore-space-change": (0, "b"), "ignore-tab-expansion": (0, "E"),
         "ignore-trailing-space": (0, "Z"), "inhibit-hunk-merge": (0, "inhibit"), "initial-tab": (0, "T"),
         "label": (1, "L"), "left-column": (0, "left-column"), "line-format": (1, "formats"), "minimal": (0, "d"),
         "new-file": (0, "N"), "new-group-format": (1, "formats"), "new-line-format": (1, "formats"),
         "no-dereference": (0, "no-deref"), "no-ignore-file-name-case": (0, "no-name-case"), "normal": (0, "normal"),
         "old-group-format": (1, "formats"), "old-line-format": (1, "formats"), "paginate": (0, "l"),
         "palette": (1, "palette"), "rcs": (0, "n"), "recursive": (0, "r"), "report-identical-files": (0, "s"),
         "sdiff-merge-assist": (0, "merge-assist"), "show-c-function": (0, "p"), "show-function-line": (1, "F"),
         "side-by-side": (0, "y"), "speed-large-files": (0, "H"), "starting-file": (1, "S"),
         "strip-trailing-cr": (0, "strip-cr"), "suppress-blank-empty": (0, "sbe"),
         "suppress-common-lines": (0, "suppress-common"), "tabsize": (1, "tabsize"), "text": (0, "a"),
         "to-file": (1, "to-file"), "unchanged-group-format": (1, "formats"), "unchanged-line-format": (1, "formats"),
         "unidirectional-new-file": (0, "P"), "unified": (2, "U"), "version": (0, "v"), "width": (1, "W")}
    options, operands, words = _getopt_long(
        "diff", argv, "0123456789abBcC:dD:eEfF:hHiI:lL:nNpPqrsS:tTuU:vwW:x:X:yZ", L)

    def usage_error(message):
        sys.stderr.write(f"diff: {message}\ndiff: Try 'diff --help' for more information.\n")
        raise SystemExit(2)

    def refuse(what):
        die("diff", f"{what} is not supported here. Supported: the normal, -u/-U, -c/-C, -y, -e, -f, -n "
                    "and -q formats, -r -N -i -w -b -B -E -Z -I -p -F -x -X -s -t -T -a -d -H --label")

    style = None
    context, ocontext, explicit_context = 0, -1, False
    brief = report_identical = recursive = new_file = unidir = ignore_case = text = False
    ignore_blank = strip_cr = expand_tabs = initial_tab = sbe = left_column = suppress_common = False
    minimal = speed = no_deref = show_c_function = False
    ws, horizon, width, tabsize = 0, 0, 0, 0
    labels, ignore_res, function_res, excludes = [], [], [], []
    starting_file = from_file = to_file = None
    prev = None

    def specify(new):
        nonlocal style
        if style != new:
            if style is not None:
                usage_error("conflicting output style options")
            style = new

    def number(value, what, low=0):
        if not re.fullmatch(r"[+-]?\d+", value or "") or int(value) < low:
            usage_error(f"invalid {what} '{value}'")
        return int(value)

    for key, value in options:
        if key.isdigit() and len(key) == 1:
            ocontext = int(key) if not (prev and prev.isdigit() and len(prev) == 1) else ocontext * 10 + int(key)
        elif key == "a":
            text = True
        elif key in ("b", "Z", "E"):
            if ws < 4:
                ws = 4 if key == "b" else ws | (2 if key == "Z" else 1)
        elif key == "w":
            ws = 5
        elif key == "B":
            ignore_blank = True
        elif key in ("C", "U"):
            n = number(value, "context length") if value is not None else 3
            specify("unified" if key == "U" else "context")
            context = max(context, n)
            explicit_context = True
        elif key in ("c", "u"):
            specify("context" if key == "c" else "unified")
            context = max(context, 3)
        elif key == "d":
            minimal = True
        elif key == "H":
            speed = True
        elif key == "i":
            ignore_case = True
        elif key == "I":
            try:
                ignore_res.append(_gnu_regex(value, "basic"))
            except re.error as e:
                die("diff", f"{value}: {e}")
        elif key == "F":
            try:
                function_res.append(_gnu_regex(value, "basic"))
            except re.error as e:
                die("diff", f"{value}: {e}")
        elif key == "p":
            show_c_function = True
            function_res.append(_gnu_regex("^[[:alpha:]$_]", "basic"))
        elif key == "L":
            if len(labels) >= 2:
                die("diff", "too many file label options")
            labels.append(value)
        elif key == "N":
            new_file = True
        elif key == "P":
            unidir = True
        elif key == "q":
            brief = True
        elif key == "r":
            recursive = True
        elif key == "s":
            report_identical = True
        elif key == "S":
            starting_file = value
        elif key == "t":
            expand_tabs = True
        elif key == "T":
            initial_tab = True
        elif key == "x":
            excludes.append(_fnmatch_re(value))
        elif key == "X":
            try:
                with open(value, "rb") as f:
                    excludes.extend(_fnmatch_re(os.fsdecode(line)) for line in f.read().split(b"\n") if line)
            except OSError as e:
                die("diff", f"{value}: {e.strerror}")
        elif key == "y":
            specify("sdiff")
        elif key in ("e", "f", "n"):
            specify({"e": "ed", "f": "forward-ed", "n": "rcs"}[key])
        elif key == "W":
            w = number(value, "width", 1)
            if width and width != w:
                die("diff", "conflicting width options")
            width = w
        elif key == "normal":
            specify("normal")
        elif key == "tabsize":
            t = number(value, "tabsize", 1)
            if tabsize and tabsize != t:
                die("diff", "conflicting tabsize options")
            tabsize = t
        elif key == "horizon":
            horizon = max(horizon, number(value, "horizon length"))
        elif key == "left-column":
            left_column = True
        elif key == "suppress-common":
            suppress_common = True
        elif key == "sbe":
            sbe = True
        elif key == "strip-cr":
            strip_cr = True
        elif key == "no-deref":
            no_deref = True
        elif key == "from-file":
            from_file = value
        elif key == "to-file":
            to_file = value
        elif key in ("binary", "inhibit", "h", "no-name-case"):
            pass
        elif key == "color":
            if value not in (None, "never", "auto"):
                refuse(f"--color={value}")
        elif key == "help":
            print("Usage: diff [OPTION]... FILES\nCompare FILES line by line.\n\n"
                  "This is pad's diff, which follows GNU diffutils 3.10.")
            return 0
        elif key == "v":
            print("diff (pad, following GNU diffutils) 3.10")
            return 0
        else:
            names = {"D": "-D/--ifdef", "l": "-l/--paginate",
                     "formats": "--*-line-format/--*-group-format", "palette": "--palette",
                     "name-case": "--ignore-file-name-case", "merge-assist": "--sdiff-merge-assist"}
            refuse(names.get(key, key))
        prev = key
    if style is None:
        if show_c_function:
            specify("context")
            if ocontext < 0:
                context = 3
        else:
            specify("normal")
    if 0 <= ocontext and style in ("context", "unified") and (
            context < ocontext or (ocontext < context and not explicit_context)):
        context = ocontext
    tabsize = tabsize or 8
    width = width or 130
    t = 1 if expand_tabs else tabsize
    unaligned = (width >> 1) + ((t + 3) >> 1) + (width & (t + 3) & 1)
    off = unaligned - unaligned % t
    half = 0 if (off <= 3 or width <= off) else min(off - 3, width - off)
    column2 = off if half else width
    horizon = max(horizon, context)
    no_diff_no_output = style != "sdiff" or suppress_common
    switch = "".join(" " + _shell_quote(w) for w in words).encode()
    ctime_header = style == "context" and _c_locale("LC_TIME")
    out = sys.stdout.buffer
    HIDDEN = ".ajar"   # the shims' own folder; find leaves it out the same way

    def message(text):
        out.write(os.fsencode(text))

    def perror(path, e):
        out.flush()
        sys.stderr.write(f"diff: {path}: {e.strerror}\n")

    def c_escape(name):
        raw = os.fsencode(name)
        escapes = {7: b"a", 8: b"b", 9: b"t", 10: b"n", 11: b"v", 12: b"f", 13: b"r", 34: b'"', 92: b"\\"}
        if b" " not in raw and not any(c in escapes or c < 32 or c >= 128 for c in raw):
            return raw
        body = bytearray(b'"')
        for c in raw:
            if c in escapes:
                body += b"\\" + escapes[c]
            elif c < 32 or c >= 128:
                body += b"\\%03o" % c
            else:
                body.append(c)
        return bytes(body + b'"')

    def stamp(ns):
        sec, nsec = divmod(ns, 10 ** 9)
        tm = time.localtime(sec)
        if ctime_header:
            return (f"{'SunMonTueWedThuFriSat'[(tm.tm_wday + 1) % 7 * 3:][:3]} "
                    f"{'JanFebMarAprMayJunJulAugSepOctNovDec'[(tm.tm_mon - 1) * 3:][:3]} {tm.tm_mday:2d} "
                    f"{tm.tm_hour:02d}:{tm.tm_min:02d}:{tm.tm_sec:02d} {tm.tm_year}")
        gmtoff = getattr(tm, "tm_gmtoff", 0) or 0
        sign, gmtoff = ("-", -gmtoff) if gmtoff < 0 else ("+", gmtoff)
        return (f"{tm.tm_year:04d}-{tm.tm_mon:02d}-{tm.tm_mday:02d} {tm.tm_hour:02d}:{tm.tm_min:02d}:"
                f"{tm.tm_sec:02d}.{nsec:09d} {sign}{gmtoff // 3600:02d}{gmtoff // 60 % 60:02d}")

    def key_of(line, incomplete):
        t = line[:-1] if line.endswith(b"\n") else line
        if ws == 5:
            t = re.sub(rb"[ \t\n\v\f\r]+", b"", t)
        elif ws == 4:
            t = re.sub(rb"[ \t\n\v\f\r]+", b" ", t)
            if t.endswith(b" "):
                t = t[:-1]
        else:
            if ws & 1:
                col, chars = 0, bytearray()
                for c in t:
                    if c == 8:
                        col -= col > 0
                        chars.append(c)
                    elif c == 9:
                        n = tabsize - col % tabsize
                        chars += b" " * n
                        col += n
                    elif c == 13:
                        col = 0
                        chars.append(c)
                    else:
                        col += 1
                        chars.append(c)
                t = bytes(chars)
            if ws & 2:
                t = t.rstrip(b" \t\n\v\f\r")
        if ignore_case:
            t = t.lower()
        return (t, True) if incomplete and ws < 2 else t

    stdin_data = []

    def read(path):
        if path == "-":
            if not stdin_data:
                stdin_data.append(sys.stdin.buffer.read())
            return stdin_data[0]
        with open(path, "rb") as f:
            return f.read()

    def file_type(st):
        mode = st.st_mode if st else 0
        if stat.S_ISREG(mode):
            return "regular empty file" if st.st_size == 0 else "regular file"
        return {stat.S_IFDIR: "directory", stat.S_IFLNK: "symbolic link", stat.S_IFIFO: "fifo",
                stat.S_IFSOCK: "socket", stat.S_IFCHR: "character special file",
                stat.S_IFBLK: "block special file"}.get(stat.S_IFMT(mode), "weird file")

    def concat(directory, name):
        return directory + name if directory.endswith("/") else directory + "/" + name

    def diff_two(info, paths, in_dir):
        data = []
        for f in (0, 1):
            if info[f]["gone"]:
                data.append(b"")
            elif f == 1 and info[1]["same"]:
                data.append(data[0])
            else:
                try:
                    data.append(read(paths[f]))
                except OSError as e:
                    perror(paths[f], e)
                    return 2
        names = [labels[0] if labels else paths[0], labels[1] if len(labels) > 1 else paths[1]]
        if not text:
            # GNU decides from the first buffer it reads, a block's worth.
            sizes = [max(getattr(i["st"], "st_blksize", 0) or 4096, 4096) for i in info]
            if b"\0" in data[0][: sizes[0]] or b"\0" in data[1][: sizes[1]]:
                if data[0] == data[1]:
                    return 0
                message(f"{'Files' if brief else 'Binary files'} {names[0]} and {names[1]} differ\n")
                return 1
        if strip_cr:
            data = [d.replace(b"\r\n", b"\n") for d in data]
        # ed scripts cannot say "no newline", so GNU completes the line and
        # complains afterwards rather than print a script that lies.
        robust = style not in ("ed", "forward-ed")
        missing = [bool(d) and not d.endswith(b"\n") for d in data]
        if not robust:
            data = [d + b"\n" if m else d for d, m in zip(data, missing)]
        a, b = _diff_lines(data[0]), _diff_lines(data[1])
        script = _diff_script(a, b, key_of, horizon, minimal, speed)

        def trivial(lines, lo, hi):
            if not (ignore_blank or ignore_res):
                return False
            for line in lines[lo:hi]:
                t = line[:-1] if line.endswith(b"\n") else line
                blank = ignore_blank and (not t or (ws >= 2 and not t.strip(b" \t\n\v\f\r")))
                if not blank and not any(r.search(t) for r in ignore_res):
                    return False
            return True

        def analyze(hunk):
            first0, first1 = hunk[0][0], hunk[0][1]
            show_from = show_to = 0
            is_trivial = True
            for l0, l1, deleted, inserted in hunk:
                show_from += deleted
                show_to += inserted
                if is_trivial and not (trivial(a, l0, l0 + deleted) and trivial(b, l1, l1 + inserted)):
                    is_trivial = False
            last0 = hunk[-1][0] + hunk[-1][2] - 1
            last1 = hunk[-1][1] + hunk[-1][3] - 1
            if (ignore_blank or ignore_res) and is_trivial:
                return 0, first0, last0, first1, last1
            return (1 if show_from else 0) | (2 if show_to else 0), first0, last0, first1, last1

        changes = any(analyze([c])[0] for c in script) if (ignore_blank or ignore_res) else bool(script)

        def finish(status):
            if not robust and any(missing):
                out.flush()
                for f in (0, 1):
                    if missing[f]:
                        sys.stderr.write(f"diff: {names[f]}: No newline at end of file\n\n")
                return 2
            return status

        if brief:
            if changes:
                message(f"Files {names[0]} and {names[1]} differ\n")
            return finish(1 if changes else 0)
        if not changes and no_diff_no_output:
            return finish(0)
        chunks = []
        w = chunks.append
        started = []
        escaped = [c_escape(names[0]), c_escape(names[1])]

        def label(mark, f):
            if f < len(labels):
                w(f"{mark} {labels[f]}\n".encode())
            else:
                ns = 0 if info[f]["gone"] else info[f]["mtime"]
                w(mark.encode() + b" " + escaped[f] + b"\t" + stamp(ns).encode() + b"\n")

        def begin():
            if started:
                return
            started.append(True)
            if in_dir:
                w(b"diff" + switch + b" " + escaped[0] + b" " + escaped[1] + b"\n")
            if style == "context":
                label("***", 0)
                label("---", 1)
            elif style == "unified":
                label("---", 0)
                label("+++", 1)

        def text_of(line, flag):
            body = line[:-1] if line.endswith(b"\n") else line
            if expand_tabs:
                col, o = 0, bytearray()
                for k, c in enumerate(body):
                    if c == 9:
                        n = tabsize - col % tabsize
                        col += n
                        o += b" " * n
                    elif c == 13:
                        o.append(c)
                        if flag and k + 1 < len(body):
                            o += flag
                        col = 0
                    elif c == 8:
                        if col == 0:
                            continue
                        col -= 1
                        o.append(c)
                    else:
                        col += 32 <= c < 127
                        o.append(c)
                body = bytes(o)
            return body

        def emit(flag, line):
            # print_1_line_nl: the flag, the text, then the newline or the marker.
            if flag:
                fmt_flag = flag + (b"\t" if initial_tab else b" ")
                if sbe and line == b"\n":
                    w(flag[1:] if flag.startswith(b" ") else flag)
                else:
                    w(fmt_flag)
            w(text_of(line, (flag + (b"\t" if initial_tab else b" ")) if flag else None))
            w(b"\n" if line.endswith(b"\n") else b"\n\\ No newline at end of file\n")

        def emit_unified(tag, line):
            w(tag)
            if initial_tab and not (sbe and line == b"\n"):
                w(b"\t")
            w(text_of(line, None))
            w(b"\n" if line.endswith(b"\n") else b"\n\\ No newline at end of file\n")

        def number_range(first, last, sep=b","):
            ta, tb = first + 1, last + 1
            return b"%d%s%d" % (ta, sep, tb) if tb > ta else b"%d" % tb

        last_search = [0]
        last_match = [None]

        def find_function(linenum):
            i, last = linenum, last_search[0]
            last_search[0] = linenum
            while True:
                i -= 1
                if i < last:
                    break
                line = a[i][:-1] if a[i].endswith(b"\n") else a[i]
                if any(r.search(line) for r in function_res):
                    last_match[0] = i
                    return a[i]
            return a[last_match[0]] if last_match[0] is not None else None

        def function_text(line):
            line = line[:-1] if line.endswith(b"\n") else line
            i = 0
            while i < len(line) and line[i] in b" \t\v\f\r":
                i += 1
            j = min(len(line), i + 40)
            while i < j and line[j - 1] in b" \t\n\v\f\r":
                j -= 1
            return b" " + line[i:j]

        def hunks():
            # find_hunk: changes closer than 2*context+1 lines (context, when
            # the next one is ignorable) belong together.
            marks = [not analyze([c])[0] for c in script] if (ignore_blank or ignore_res) else [False] * len(script)
            k = 0
            while k < len(script):
                start = k
                while k + 1 < len(script):
                    top0 = script[k][0] + script[k][2]
                    thresh = context if marks[k + 1] else 2 * context + 1
                    if script[k + 1][0] - top0 < thresh:
                        k += 1
                    else:
                        break
                yield script[start : k + 1]
                k += 1

        if style in ("ed", "forward-ed", "rcs"):
            for change in (reversed(script) if style == "ed" else script):
                kinds, first0, last0, first1, last1 = analyze([change])
                if not kinds:
                    continue
                begin()
                if style == "rcs":
                    t0, t1 = first0 + 1, last0 + 1
                    if kinds & 1:
                        w(b"d%d %d\n" % (t0, t1 - t0 + 1 if t0 <= t1 else 1))
                    if kinds & 2:
                        w(b"a%d %d\n" % (t1, last1 - first1 + 1 if first1 <= last1 else 1))
                        for i in range(first1, last1 + 1):
                            w(b[i])
                    continue
                letter = b" dac"[kinds : kinds + 1]
                if style == "ed":
                    w(number_range(first0, last0) + letter + b"\n")
                else:
                    w(letter + number_range(first0, last0, b" ") + b"\n")
                if kinds == 1:
                    continue
                insert_mode = True
                for i in range(first1, last1 + 1):
                    if not insert_mode:
                        w(b"a\n")
                        insert_mode = True
                    if style == "ed" and b[i] == b".\n":
                        # A line of just a dot would end ed's insert mode.
                        w(b"..\n.\ns/.//\n")
                        insert_mode = False
                    else:
                        w(b[i])
                if insert_mode:
                    w(b".\n")
        elif style == "normal":
            for change in script:
                kinds, first0, last0, first1, last1 = analyze([change])
                if not kinds:
                    continue
                begin()
                w(number_range(first0, last0) + b" dac"[kinds : kinds + 1] + number_range(first1, last1) + b"\n")
                if kinds & 1:
                    for i in range(first0, last0 + 1):
                        emit(b"<", a[i])
                if kinds == 3:
                    w(b"---\n")
                if kinds & 2:
                    for i in range(first1, last1 + 1):
                        emit(b">", b[i])
        elif style in ("unified", "context"):
            for hunk in hunks():
                kinds, first0, last0, first1, last1 = analyze(hunk)
                if not kinds:
                    continue
                first0, first1 = max(first0 - context, 0), max(first1 - context, 0)
                last0, last1 = min(last0 + context, len(a) - 1), min(last1 + context, len(b) - 1)
                function = find_function(first0) if function_res else None
                begin()
                if style == "unified":
                    def urange(first, last):
                        ta, tb = first + 1, last + 1
                        if tb <= ta:
                            return b"%d,0" % tb if tb < ta else b"%d" % tb
                        return b"%d,%d" % (ta, tb - ta + 1)
                    w(b"@@ -" + urange(first0, last0) + b" +" + urange(first1, last1) + b" @@")
                    if function is not None:
                        w(function_text(function))
                    w(b"\n")
                    i, j, k = first0, first1, 0
                    while i <= last0 or j <= last1:
                        if k >= len(hunk) or i < hunk[k][0]:
                            line = a[i]
                            if not (sbe and line == b"\n"):
                                w(b"\t" if initial_tab else b" ")
                            w(text_of(line, None))
                            w(b"\n" if line.endswith(b"\n") else b"\n\\ No newline at end of file\n")
                            i += 1
                            j += 1
                        else:
                            for _ in range(hunk[k][2]):
                                emit_unified(b"-", a[i])
                                i += 1
                            for _ in range(hunk[k][3]):
                                emit_unified(b"+", b[j])
                                j += 1
                            k += 1
                else:
                    def crange(first, last):
                        ta, tb = first + 1, last + 1
                        return b"%d" % tb if tb <= ta else b"%d,%d" % (ta, tb)
                    w(b"***************")
                    if function is not None:
                        w(function_text(function))
                    w(b"\n*** " + crange(first0, last0) + b" ****\n")
                    if kinds & 1:
                        k = 0
                        for i in range(first0, last0 + 1):
                            while k < len(hunk) and hunk[k][0] + hunk[k][2] <= i:
                                k += 1
                            flag = b" "
                            if k < len(hunk) and hunk[k][0] <= i:
                                flag = b"!" if hunk[k][3] > 0 else b"-"
                            emit(flag, a[i])
                    w(b"--- " + crange(first1, last1) + b" ----\n")
                    if kinds & 2:
                        k = 0
                        for i in range(first1, last1 + 1):
                            while k < len(hunk) and hunk[k][1] + hunk[k][3] <= i:
                                k += 1
                            flag = b" "
                            if k < len(hunk) and hunk[k][1] <= i:
                                flag = b"!" if hunk[k][2] > 0 else b"+"
                            emit(flag, b[i])
        else:
            def tab_to(frm, to):
                if not expand_tabs:
                    tab = frm + tabsize - frm % tabsize
                    while tab <= to:
                        w(b"\t")
                        frm = tab
                        tab += tabsize
                if frm < to:
                    w(b" " * (to - frm))
                return to

            def half_line(line, indent, bound):
                in_pos = out_pos = 0
                o = bytearray()
                for c in line:
                    if c == 10:
                        break
                    if c == 9:
                        spaces = tabsize - in_pos % tabsize
                        if in_pos == out_pos:
                            stop = out_pos + spaces
                            if expand_tabs:
                                stop = min(stop, bound)
                                o += b" " * max(0, stop - out_pos)
                                out_pos = max(out_pos, stop)
                            elif stop < bound:
                                out_pos = stop
                                o.append(c)
                        in_pos += spaces
                    elif c == 13:
                        o.append(c)
                        w(bytes(o))
                        o = bytearray()
                        tab_to(0, indent)
                        in_pos = out_pos = 0
                    elif c == 8:
                        if in_pos != 0:
                            in_pos -= 1
                            if in_pos < bound:
                                if out_pos <= in_pos:
                                    o += b" " * (in_pos - out_pos)
                                    out_pos = in_pos
                                else:
                                    out_pos = in_pos
                                    o.append(c)
                    elif 32 <= c < 127:
                        if in_pos < bound:
                            in_pos += 1
                            out_pos = in_pos
                            o.append(c)
                        else:
                            in_pos += 1
                    elif c in (0, 11, 12) or c >= 128:
                        if in_pos < bound:
                            o.append(c)
                    elif in_pos <= bound:
                        out_pos = in_pos
                        o.append(c)
                w(bytes(o))
                return out_pos

            def sdiff_line(left, sep, right):
                col = 0
                newline = False
                if left is not None:
                    newline = newline or left.endswith(b"\n")
                    col = half_line(left, 0, half)
                if sep != " ":
                    col = tab_to(col, (half + column2 - 1) // 2) + 1
                    if sep == "|" and newline != right.endswith(b"\n"):
                        sep = "/" if newline else "\\"
                    w(sep.encode())
                if right is not None:
                    newline = newline or right.endswith(b"\n")
                    if right[:1] not in (b"\n",):
                        col = tab_to(col, column2)
                        half_line(right, col, half)
                if newline:
                    w(b"\n")

            nxt = [0, 0]

            def common(limit0, limit1):
                i0, i1 = nxt
                if not suppress_common and (i0 != limit0 or i1 != limit1):
                    if not left_column:
                        while i0 != limit0 and i1 != limit1:
                            sdiff_line(a[i0], " ", b[i1])
                            i0 += 1
                            i1 += 1
                        while i1 != limit1:
                            sdiff_line(None, ")", b[i1])
                            i1 += 1
                    while i0 != limit0:
                        sdiff_line(a[i0], "(", None)
                        i0 += 1
                nxt[:] = [limit0, limit1]

            begin()
            for change in script:
                kinds, first0, last0, first1, last1 = analyze([change])
                if not kinds:
                    continue
                common(first0, first1)
                if kinds == 3:
                    i, j = first0, first1
                    while i <= last0 and j <= last1:
                        sdiff_line(a[i], "|", b[j])
                        i += 1
                        j += 1
                    kinds = (1 if i <= last0 else 0) + (2 if j <= last1 else 0)
                    nxt[:] = [i, j]
                    first0, first1 = i, j
                if kinds & 2:
                    for j in range(first1, last1 + 1):
                        sdiff_line(None, ">", b[j])
                    nxt[1] = last1 + 1
                if kinds & 1:
                    for i in range(first0, last0 + 1):
                        sdiff_line(a[i], "<", None)
                    nxt[0] = last0 + 1
            common(len(a), len(b))
        out.write(b"".join(chunks))
        return finish(1 if changes else 0)

    def compare(parent, name0, name1):
        if not ((name0 is not None and name1 is not None) or (unidir and name1 is not None) or new_file):
            message(f"Only in {parent[0 if name0 is not None else 1]}: {name0 if name0 is not None else name1}\n")
            return 1
        present = [name0 is not None, name1 is not None]
        name0 = name1 if name0 is None else name0
        name1 = name0 if name1 is None else name1
        paths = [concat(parent[0], name0), concat(parent[1], name1)] if parent else [name0, name1]
        info = [dict(st=None, err=None, stdin=False, same=False, gone=not present[f], mtime=0) for f in (0, 1)]
        for f in (0, 1):
            if not present[f]:
                continue
            if f == 1 and present[0] and paths[1] == paths[0]:
                info[1].update(st=info[0]["st"], err=info[0]["err"], stdin=info[0]["stdin"], same=True,
                               mtime=info[0]["mtime"])
            elif paths[f] == "-":
                info[f]["stdin"] = True
                try:
                    info[f]["st"] = os.fstat(0)
                    info[f]["mtime"] = time.time_ns()
                except OSError as e:
                    info[f]["err"] = e
            else:
                try:
                    st = os.lstat(paths[f]) if no_deref else os.stat(paths[f])
                    info[f].update(st=st, mtime=st.st_mtime_ns)
                except OSError as e:
                    info[f]["err"] = e
        for f in (0, 1):
            if not (new_file or (f == 0 and unidir)) or info[f]["gone"]:
                continue
            st, other = info[f]["st"], info[1 - f]
            if st is not None and not info[f]["stdin"]:
                if stat.S_ISREG(st.st_mode) and not st.st_mode & 0o777 and st.st_size == 0:
                    info[f].update(gone=True, st=None)
            elif (info[f]["err"] is not None and info[f]["err"].errno in (errno.ENOENT, errno.EBADF)
                  and not parent and other["st"] is not None):
                info[f].update(gone=True, err=None)
        status = 0
        for f in (0, 1):
            if info[f]["err"] is not None and not info[f]["gone"]:
                perror(paths[f], info[f]["err"])
                status = 2

        def mode(f):
            i = info[f]
            if i["gone"]:
                return info[1 - f]["st"].st_mode if info[1 - f]["st"] is not None else 0
            return i["st"].st_mode if i["st"] is not None else 0

        is_dir = lambda f: stat.S_ISDIR(mode(f))
        if status == 0 and not parent and is_dir(0) != is_dir(1):
            fnm_arg = 1 if is_dir(0) else 0
            dir_arg = 1 - fnm_arg
            if paths[fnm_arg] == "-":
                die("diff", "cannot compare '-' to a directory")
            paths[dir_arg] = concat(paths[dir_arg], os.path.basename(paths[fnm_arg].rstrip("/")) or paths[fnm_arg])
            try:
                st = os.lstat(paths[dir_arg]) if no_deref else os.stat(paths[dir_arg])
                info[dir_arg].update(st=st, mtime=st.st_mtime_ns)
            except OSError as e:
                perror(paths[dir_arg], e)
                status = 2
        if status != 0:
            pass
        elif info[0]["gone"] and info[1]["gone"]:
            pass
        elif info[1]["same"] and no_diff_no_output:
            pass
        elif is_dir(0) and is_dir(1):
            if parent and not recursive:
                message(f"Common subdirectories: {paths[0]} and {paths[1]}\n")
            else:
                status = diff_dirs(paths, info, parent is None)
        elif is_dir(0) or is_dir(1) or (parent and not all(
                stat.S_ISREG(mode(f)) or stat.S_ISLNK(mode(f)) for f in (0, 1))):
            if info[0]["gone"] or info[1]["gone"]:
                if (is_dir(0) or is_dir(1)) and recursive and (new_file or (unidir and info[0]["gone"])):
                    status = diff_dirs(paths, info, parent is None)
                else:
                    message(f"Only in {parent[1 if info[0]['gone'] else 0]}: {name0}\n")
                    status = 1
            else:
                message(f"File {labels[0] if labels else paths[0]} is a {file_type(info[0]['st'])} while file "
                        f"{labels[1] if len(labels) > 1 else paths[1]} is a {file_type(info[1]['st'])}\n")
                status = 1
        elif stat.S_ISLNK(mode(0)) or stat.S_ISLNK(mode(1)):
            if stat.S_ISLNK(mode(0)) and stat.S_ISLNK(mode(1)):
                try:
                    if os.readlink(paths[0]) != os.readlink(paths[1]):
                        message(f"Symbolic links {paths[0]} and {paths[1]} differ\n")
                        status = 1
                except OSError as e:
                    perror(paths[0], e)
                    status = 2
            else:
                message(f"File {paths[0]} is a {file_type(info[0]['st'])} while file "
                        f"{paths[1]} is a {file_type(info[1]['st'])}\n")
                status = 1
        else:
            status = diff_two(info, paths, parent is not None)
        if status == 0 and report_identical and not is_dir(0):
            message(f"Files {labels[0] if labels else paths[0]} and {labels[1] if len(labels) > 1 else paths[1]}"
                    " are identical\n")
        out.flush()
        return status

    def diff_dirs(paths, info, top):
        listing = []
        for f in (0, 1):
            if info[f]["gone"]:
                listing.append([])
                continue
            try:
                names = os.listdir(paths[f])
            except OSError as e:
                perror(paths[f], e)
                return 2
            listing.append(sorted(n for n in names if n != HIDDEN
                                  and not any(r.match(os.fsencode(n)) for r in excludes)))
        if starting_file and top:
            listing = [[n for n in names if n >= starting_file] for names in listing]
        status, i, j = 0, 0, 0
        n0, n1 = listing
        while i < len(n0) or j < len(n1):
            if j >= len(n1) or (i < len(n0) and n0[i] < n1[j]):
                s = compare(paths, n0[i], None)
                i += 1
            elif i >= len(n0) or n1[j] < n0[i]:
                s = compare(paths, None, n1[j])
                j += 1
            else:
                s = compare(paths, n0[i], n1[j])
                i += 1
                j += 1
            status = max(status, s)
        return status

    if from_file is not None and to_file is not None:
        die("diff", "--from-file and --to-file both specified")
    if from_file is not None or to_file is not None:
        status = 0
        for name in operands:
            status = max(status, compare(None, from_file, name) if from_file is not None else compare(None, name, to_file))
        return status
    if len(operands) != 2:
        if len(operands) < 2:
            usage_error(f"missing operand after '{argv[-1] if argv else 'diff'}'")
        usage_error(f"extra operand '{operands[2]}'")
    return compare(None, operands[0], operands[1])


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
    """GNU md5sum / sha1sum / sha256sum: -b, -t, --tag, and -c with its reports.

    A file that cannot be read is reported and the rest are still hashed. A
    name with a backslash, newline or CR in it is escaped and its line marked
    with a leading backslash, as GNU does, so that -c can read it back.
    -c reads the binary marker, the BSD-style --tag lines and upper-case hex,
    and ends with GNU's warnings about what did not match.
    """
    tool = f"{algorithm}sum"
    tag_name = {"md5": "MD5", "sha1": "SHA1", "sha256": "SHA256"}[algorithm]
    width = hashlib.new(algorithm).digest_size * 2
    check = binary = tag = quiet = status_only = strict = warn = ignore_missing = zero = False
    files, only_files = [], False
    longs = {"--check": "c", "--binary": "b", "--text": "t", "--warn": "w", "--tag": "T", "--quiet": "Q",
             "--status": "S", "--strict": "X", "--ignore-missing": "I", "--zero": "z"}
    supported = "Supported: -c -b -t -w -z --tag --quiet --status --strict --ignore-missing"
    for a in argv:
        if only_files or not a.startswith("-") or a == "-":
            files.append(a)
            continue
        if a == "--":
            only_files = True
            continue
        if a.startswith("--") and a not in longs:
            die(tool, f"unsupported option '{a}'. {supported}")
        for f in [longs[a]] if a.startswith("--") else a[1:]:
            if f == "c":
                check = True
            elif f in "bt":
                binary = f == "b"
            elif f == "w":
                warn = True
            elif f == "T":
                tag = True
            elif f == "Q":
                quiet = True
            elif f == "S":
                status_only = True
            elif f == "X":
                strict = True
            elif f == "I":
                ignore_missing = True
            elif f == "z":
                zero = True
            else:
                die(tool, f"unsupported option '-{f}'. {supported}")
    if check and zero:
        die(tool, "-z with -c is not supported here")

    def digest_of(name):
        h = hashlib.new(algorithm)
        if name == "-":
            h.update(sys.stdin.buffer.read())
        else:
            with open(name, "rb") as f:
                for block in iter(lambda: f.read(65536), b""):
                    h.update(block)
        return h.hexdigest()

    def escaped(name):
        if any(ch in name for ch in "\\\n\r"):
            return "\\", name.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")
        return "", name

    def say(text):
        sys.stdout.buffer.write((text + "\n").encode("utf-8", "surrogateescape"))

    status = 0
    if not check:
        for name in files or ["-"]:
            try:
                digest = digest_of(name)
            except OSError as e:
                sys.stderr.write(f"{tool}: {name}: {e.strerror}\n")
                status = 1
                continue
            mark, shown = ("", name) if zero else escaped(name)
            line = f"{mark}{tag_name} ({shown}) = {digest}" if tag else f"{mark}{digest} {'*' if binary else ' '}{shown}"
            sys.stdout.buffer.write((line + ("\0" if zero else "\n")).encode("utf-8", "surrogateescape"))
        return status

    def parse(line):
        mark = line.startswith("\\")
        body = line[1:] if mark else line
        target = None
        if body.startswith(tag_name + " (") and ") = " in body:
            target, _, want = body[len(tag_name) + 2 :].rpartition(") = ")
        elif len(body) > width and body[width] in " \t":
            want, target = body[:width], body[width + 1 :]
            if target[:1] in (" ", "*"):
                target = target[1:]
        if not target or len(want) != width or any(ch not in "0123456789abcdefABCDEF" for ch in want):
            return None
        if mark:
            out, k = [], 0
            while k < len(target):
                if target[k] == "\\":
                    nxt = target[k + 1 : k + 2]
                    if nxt not in ("\\", "n", "r"):
                        return None
                    out.append({"\\": "\\", "n": "\n", "r": "\r"}[nxt])
                    k += 2
                else:
                    out.append(target[k])
                    k += 1
            target = "".join(out)
        return want.lower(), target

    for listname in files or ["-"]:
        shown_list = "standard input" if listname == "-" else listname
        try:
            if listname == "-":
                data = sys.stdin.buffer.read()
            else:
                with open(listname, "rb") as f:
                    data = f.read()
        except OSError as e:
            sys.stderr.write(f"{tool}: {listname}: {e.strerror}\n")
            status = 1
            continue
        misformatted = unreadable = mismatched = 0
        formatted = verified = False
        lines = data.split(b"\n")
        if lines and not lines[-1]:
            lines.pop()
        for number, raw in enumerate(lines, start=1):
            line = raw.decode("utf-8", "surrogateescape")
            if line.startswith("#"):
                continue
            line = line[:-1] if line.endswith("\r") else line
            if not line:
                continue
            parsed = parse(line)
            if parsed is None:
                misformatted += 1
                if warn:
                    sys.stderr.write(f"{tool}: {shown_list}: {number}: improperly formatted {tag_name} checksum line\n")
                continue
            formatted = True
            want, target = parsed
            mark, shown = escaped(target)
            try:
                got = digest_of(target)
            except FileNotFoundError as e:
                if ignore_missing:
                    continue
                unreadable += 1
                sys.stderr.write(f"{tool}: {target}: {e.strerror}\n")
                if not status_only:
                    say(f"{mark}{shown}: FAILED open or read")
                continue
            except OSError as e:
                unreadable += 1
                sys.stderr.write(f"{tool}: {target}: {e.strerror}\n")
                if not status_only:
                    say(f"{mark}{shown}: FAILED open or read")
                continue
            verified = True
            ok = got == want
            mismatched += 0 if ok else 1
            if not status_only and not (ok and quiet):
                say(f"{mark}{shown}: {'OK' if ok else 'FAILED'}")
        if not formatted:
            sys.stderr.write(f"{tool}: {shown_list}: no properly formatted checksum lines found\n")
            status = 1
            continue
        if not status_only:
            for count, one, many in ((misformatted, "line is improperly formatted", "lines are improperly formatted"),
                                     (unreadable, "listed file could not be read", "listed files could not be read"),
                                     (mismatched, "computed checksum did NOT match", "computed checksums did NOT match")):
                if count:
                    sys.stderr.write(f"{tool}: WARNING: {count} {one if count == 1 else many}\n")
        if ignore_missing and not verified:
            sys.stderr.write(f"{tool}: {shown_list}: no file was verified\n")
            status = 1
        if mismatched or unreadable or (strict and misformatted):
            status = 1
    return status


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
    """Info-ZIP zip 3.0 as it is mostly used: add files to an archive, or update it.

    An archive that exists is added to: an entry of the same name is replaced
    ("updating:") and the others are kept. -r adds each directory as an entry
    of its own, so an empty one survives, and a directory named without -r is
    added as that one entry, as zip adds it. Files are deflated at zip's level
    6 and stored instead when that would not make them smaller, and reported
    with zip's percentages. Python's deflate gives Info-ZIP's sizes for small
    files and a few bytes fewer on large ones, so the percentage for a big
    file can be a point or so higher than zip's.
    """
    import fnmatch
    import tempfile
    import zlib

    recurse = quiet = junk = no_dirs = symlinks = in_excludes = False
    level, excludes, operands = 6, [], []
    supported = "Supported: -r -q -j -D -y -X -0..-9 -x PATTERNS"
    longs = {"--recurse-paths": "r", "--quiet": "q", "--junk-paths": "j", "--no-dir-entries": "D",
             "--symlinks": "y", "--no-extra": "X", "--exclude": "x"}
    for a in argv:
        if a.startswith("-") and len(a) > 1:
            in_excludes = False
            if a.startswith("--") and a not in longs:
                die("zip", f"unsupported option '{a}'. {supported}")
            for f in [longs[a]] if a in longs else a[1:]:
                if f == "r":
                    recurse = True
                elif f == "q":
                    quiet = True
                elif f == "j":
                    junk = True
                elif f == "D":
                    no_dirs = True
                elif f == "y":
                    symlinks = True
                elif f == "X":
                    pass  # no extra attributes are written here anyway
                elif f == "x":
                    in_excludes = True
                elif f.isdigit():
                    level = int(f)
                else:
                    die("zip", f"unsupported option '-{f}'. {supported}")
        elif in_excludes:
            excludes.append(a)
        else:
            operands.append(a)
    if not operands:
        die("zip", "needs an archive and files: zip [options] archive file ...")
    archive, targets = operands[0], operands[1:]
    if "." not in os.path.basename(archive):
        archive += ".zip"

    found, names = [], set()
    try:
        archive_stat = os.stat(archive)
    except OSError:
        archive_stat = None

    def arc_name(path):
        name = path
        while name.startswith("/"):
            name = name[1:]
        while name.startswith("./"):
            name = name[2:]
        name = "" if name == "." else name
        return os.path.basename(name) if junk else name

    def add(path):
        name = arc_name(path)
        if archive_stat is not None and os.path.exists(path) and os.path.samestat(os.stat(path), archive_stat):
            return
        link = os.path.islink(path)
        if link and symlinks:
            kind = "link"
        elif os.path.isdir(path):
            if name and not no_dirs and not junk:
                keep(name + "/", path, "dir")
            if recurse:
                for entry in os.scandir(path):
                    add(os.path.join(path, entry.name))
            return
        else:
            kind = "file"
        keep(name, path, kind)

    def keep(name, path, kind):
        if name and name not in names and not any(fnmatch.fnmatchcase(name, p) for p in excludes):
            names.add(name)
            found.append((name, path, kind))

    # zip says its warnings and errors on stdout, where its progress goes.
    for target in targets:
        if not os.path.lexists(target):
            sys.stdout.write(f"\tzip warning: name not matched: {target}\n")
            continue
        add(target.rstrip("/") or target)
    if not found:
        sys.stdout.write(f"\nzip error: Nothing to do! ({archive})\n")
        return 12

    old_entries = []
    if archive_stat is not None:
        try:
            with zipfile.ZipFile(archive) as old:
                old_entries = [(info, old.read(info)) for info in old.infolist()]
        except (zipfile.BadZipFile, OSError):
            sys.stdout.write(
                "\tzip warning: missing end signature--probably not a zip file (did you\n"
                "\tzip warning: remember to use binary mode when you transferred it?)\n"
                "\tzip warning: (if you are trying to read a damaged archive try -F)\n"
                f"\nzip error: Zip file structure invalid ({archive})\n"
            )
            return 3
    old_names = {info.filename for info, _ in old_entries}

    built = {}
    for name, path, kind in found:
        if kind == "link":
            st = os.lstat(path)
            info = zipfile.ZipInfo(name, zip_time(st.st_mtime))
            info.external_attr = (st.st_mode & 0xFFFF) << 16
            data = os.fsencode(os.readlink(path))
        else:
            info = zipfile.ZipInfo.from_file(path, name, strict_timestamps=False)
            data = b""
            if kind == "file":
                try:
                    with open(path, "rb") as f:
                        data = f.read()
                except OSError:
                    sys.stdout.write(f"\tzip warning: could not open for reading: {path}\n")
                    continue
        info.filename, info.create_system = name, 3
        if kind == "dir" or not data or level == 0:
            method, packed = zipfile.ZIP_STORED, len(data)
        else:
            squeeze = zlib.compressobj(level, zlib.DEFLATED, -15)
            packed = len(squeeze.compress(data) + squeeze.flush())
            method = zipfile.ZIP_DEFLATED if packed < len(data) else zipfile.ZIP_STORED
        built[name] = (info, data, method)
        if not quiet:
            how = "stored 0%" if method == zipfile.ZIP_STORED else f"deflated {((200 * (len(data) - packed) // len(data)) + 1) // 2}%"
            sys.stdout.write(f"{'updating' if name in old_names else '  adding'}: {name} ({how})\n")

    folder = os.path.dirname(os.path.abspath(archive))
    handle, temporary = tempfile.mkstemp(prefix=".zi", dir=folder)
    os.close(handle)
    try:
        with zipfile.ZipFile(temporary, "w") as z:
            for info, data in old_entries:
                if info.filename in built:
                    new_info, new_data, method = built.pop(info.filename)
                    z.writestr(new_info, new_data, compress_type=method, compresslevel=level or None)
                else:
                    z.writestr(info, data, compress_type=info.compress_type)
            for new_info, new_data, method in built.values():
                z.writestr(new_info, new_data, compress_type=method, compresslevel=level or None)
        keep_mode_and_times(temporary, stat.S_IMODE(archive_stat.st_mode) if archive_stat else 0o666 & ~zip_umask(), None)
        os.replace(temporary, archive)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return 0


def keep_mode_and_times(path, mode, times_ns):
    """chmod and utime where the filesystem allows; the tools carry on where it does not, and so does this."""
    try:
        if mode is not None:
            os.chmod(path, mode)
        if times_ns is not None:
            os.utime(path, ns=times_ns)
    except OSError:
        pass


def zip_time(seconds):
    """A file time as a zip's local date and time — which cannot be before 1980."""
    import time

    return max(time.localtime(seconds)[:6], (1980, 1, 1, 0, 0, 0))


def zip_umask():
    try:
        mask = os.umask(0)
        os.umask(mask)
        return mask
    except (AttributeError, OSError):
        return 0o022


def zip_mtime(info):
    """When an entry was last changed: its UT extra field if zip wrote one (UTC), else its DOS time (local)."""
    import struct
    import time

    extra, i = info.extra, 0
    while i + 4 <= len(extra):
        tag, size = struct.unpack("<HH", extra[i : i + 4])
        body = extra[i + 4 : i + 4 + size]
        if tag == 0x5455 and len(body) >= 5 and body[0] & 1:
            return struct.unpack("<i", body[1:5])[0]
        i += 4 + size
    return time.mktime(info.date_time + (0, 0, -1))


def cmd_unzip(argv):
    """Info-ZIP unzip 6.0: extract, -l, -p, -t, -d, -o, -n, -q, -j and member names, as unzip says them.

    Like unzip it asks before replacing a file, unless -o or -n, and reads the
    answer from the terminal; with no answer to read it takes [N]one, as
    unzip does. Options go before the archive: after it, only -d DIR and
    -x NAMES are options, as for unzip, and anything else is a member name.
    A name with ../ in it, or a leading /, is extracted inside the
    destination with a warning, never outside it.
    """
    import fnmatch
    import time

    listing = pipe = testing = overwrite = never = junk = in_excludes = False
    quiet, dest, archive, includes, excludes = 0, None, None, [], []
    i = 0
    while i < len(argv):
        a = argv[i]
        if archive is None and a.startswith("-") and len(a) > 1:
            for j, f in enumerate(a[1:], start=1):
                if f in "lptonjq":
                    listing, pipe, testing = listing or f == "l", pipe or f == "p", testing or f == "t"
                    overwrite, never, junk = overwrite or f == "o", never or f == "n", junk or f == "j"
                    quiet += f == "q"
                elif f == "d":
                    dest = a[j + 1 :]
                    if not dest:
                        i += 1
                        dest = argv[i] if i < len(argv) else ""
                    break
                else:
                    die("unzip", f"unsupported option '-{f}'. Supported: -l -p -t -o -n -q -j -d DIR, and -x NAMES after the archive")
        elif archive is None:
            archive = a
        elif a == "-d" or (a.startswith("-d") and len(a) > 2):
            dest = a[2:]
            if not dest:
                i += 1
                dest = argv[i] if i < len(argv) else ""
        elif a == "-x":
            in_excludes = True
        else:
            (excludes if in_excludes else includes).append(a)
        i += 1
    if archive is None:
        sys.stdout.write("UnZip 6.00 (box.py). Usage: unzip [-lptonjq] [-d exdir] file[.zip] [list] [-x xlist] [-d exdir]\n")
        return 0
    path = next((p for p in (archive, archive + ".zip", archive + ".ZIP") if os.path.isfile(p)), None)
    if path is None:
        sys.stderr.write(f"unzip:  cannot find or open {archive}, {archive}.zip or {archive}.ZIP.\n")
        return 9
    if not (quiet or pipe):
        print(f"Archive:  {path}")
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        sys.stdout.flush()
        sys.stderr.write(
            "  End-of-central-directory signature not found.  Either this file is not\n"
            "  a zipfile, or it constitutes one disk of a multi-part archive.  In the\n"
            "  latter case the central directory and zipfile comment will be found on\n"
            "  the last disk(s) of this archive.\n"
            f"unzip:  cannot find zipfile directory in one of {path} or\n"
            f"        {path}.zip, and cannot find {path}.ZIP, period.\n"
        )
        return 9

    status = 0
    members = z.infolist()
    used_in, used_ex = set(), set()

    def wanted(info):
        hits = [p for p in includes if fnmatch.fnmatchcase(info.filename, p)]
        misses = [p for p in excludes if fnmatch.fnmatchcase(info.filename, p)]
        used_in.update(hits)
        used_ex.update(misses)
        return (not includes or hits) and not misses

    selected = [info for info in members if wanted(info)]

    def cautions():
        nonlocal status
        sys.stdout.flush()
        for p in excludes:
            if p not in used_ex:
                sys.stderr.write(f"caution: excluded filename not matched:  {p}\n")
        for p in includes:
            if p not in used_in:
                sys.stderr.write(f"caution: filename not matched:  {p}\n")
                status = 11

    if listing:
        print("  Length      Date    Time    Name\n---------  ---------- -----   ----")
        for info in selected:
            stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(zip_mtime(info)))
            print(f"{info.file_size:9d}  {stamp}   {info.filename}")
        count = len(selected)
        print(f"---------                     -------\n{sum(m.file_size for m in selected):9d}"
              f"                     {count} file{'' if count == 1 else 's'}")
        cautions()
        return status

    if testing:
        bad = False
        for info in selected:
            try:
                z.read(info)
                ok = "OK"
            except (zipfile.BadZipFile, OSError, EOFError) as e:
                ok, bad = f"bad CRC or data ({e})", True
            if not quiet:
                print(f"    testing: {info.filename:<22}   {ok}")
        print(f"At least one error was detected in {path}." if bad else f"No errors detected in compressed data of {path}.")
        cautions()
        return 2 if bad else status

    if pipe:
        for info in selected:
            if not info.is_dir():
                sys.stdout.buffer.write(z.read(info))
        cautions()
        return status

    base = dest or "."
    if dest:
        os.makedirs(dest, exist_ok=True)
    answer_all, directories, links = None, [], []
    for info in selected:
        parts = info.filename.split("/")
        # unzip's own split: the first of these warnings on stdout, the second on stderr.
        if ".." in parts:
            print(f'warning:  skipped "../" path component(s) in {info.filename}')
            status = max(status, 1)
        if info.filename.startswith("/"):
            sys.stdout.flush()
            sys.stderr.write(f"warning:  stripped absolute path spec from {info.filename}\n")
            status = max(status, 1)
        parts = [p for p in parts if p not in ("", ".", "..")]
        if junk:
            if info.is_dir():
                continue
            parts = parts[-1:]
        if not parts:
            continue
        clean = "/".join(parts)
        target = os.path.join(base, clean)
        shown = os.path.join(dest, clean) if dest else clean
        mode = info.external_attr >> 16 if info.create_system == 3 else 0
        if info.is_dir():
            if not os.path.isdir(target):
                os.makedirs(target)
                if not quiet:
                    print(f"   creating: {shown}/")
            directories.append((target, info, mode))
            continue
        parent = os.path.dirname(target)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent)
        if os.path.lexists(target):
            if never or answer_all is False:
                continue
            if not overwrite and answer_all is None:
                answer = unzip_ask(shown)
                if answer is None:
                    answer_all, status = False, max(status, 1)
                    continue
                if answer == "A":
                    answer_all = True
                elif answer == "N":
                    answer_all = False
                    continue
                elif answer == "n":
                    continue
                elif answer.startswith("r:"):
                    target = shown = answer[2:]
            if os.path.lexists(target) and not os.path.isdir(target):
                os.remove(target)
        data = z.read(info)
        if stat.S_ISLNK(mode):
            # unzip makes the links last, once everything they could point at is out.
            if not quiet:
                print(f"    linking: {shown:<22}  -> {os.fsdecode(data)} ")
            links.append((target, shown, os.fsdecode(data)))
            continue
        verb = "extract" if info.compress_type == zipfile.ZIP_STORED else "inflat"
        if not quiet:
            print(f"{verb:>8}ing: {shown:<22}  ")
        with open(target, "wb") as f:
            f.write(data)
        stamp = int(zip_mtime(info) * 10**9)
        keep_mode_and_times(target, stat.S_IMODE(mode) & 0o777 or None, (stamp, stamp))
    if links and not quiet:
        print("finishing deferred symbolic links:")
    for target, shown, points_at in links:
        if not quiet:
            print(f"  {shown:<22} -> {points_at}")
        try:
            os.symlink(points_at, target)
        except OSError as e:
            sys.stdout.flush()
            sys.stderr.write(f"error:  cannot create symlink {shown}: {e.strerror}\n")
            status = max(status, 1)
    for target, info, mode in reversed(directories):
        stamp = int(zip_mtime(info) * 10**9)
        keep_mode_and_times(target, stat.S_IMODE(mode) & 0o777 or None, (stamp, stamp))
    cautions()
    return status


def unzip_ask(shown):
    """unzip's question about a file that is there already: y, n, A, N, or 'r:' and a new name; None at EOF."""
    while True:
        sys.stdout.flush()
        sys.stderr.write(f"replace {shown}? [y]es, [n]o, [A]ll, [N]one, [r]ename: ")
        sys.stderr.flush()
        line = sys.stdin.readline()
        if not line:
            sys.stderr.write(' NULL\n(EOF or read error, treating as "[N]one" ...)\n')
            return None
        answer = line.strip()[:1]
        if answer in ("y", "Y"):
            return "y"
        if answer in ("n", "A", "N"):
            return answer
        if answer in ("r", "R"):
            sys.stderr.write("new name: ")
            sys.stderr.flush()
            name = sys.stdin.readline().strip()
            if name:
                return "r:" + name
        sys.stderr.write(f"error:  invalid response [{line.strip()}]\n")




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
#
# Bytes, as GNU cmp compares them. Reading the files as text, as this did,
# translated CRLF to LF on the way in, so a file and its CRLF copy came out
# "identical" — the one question cmp exists to answer.
def _cmp_number(text):
    import re

    m = re.fullmatch(r"(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)(?:([kKMGTPEZY])(iB|B|D)?)?", text or "")
    if not m:
        return None
    value = int(m.group(1), 0)
    if m.group(2):
        power = "KMGTPEZY".index(m.group(2).upper()) + 1
        value *= (1000 if m.group(3) in ("B", "D") else 1024) ** power
    return value


def cmp_files(argv):
    L = {"print-bytes": (0, "b"), "ignore-initial": (1, "i"), "verbose": (0, "l"), "bytes": (1, "n"),
         "quiet": (0, "s"), "silent": (0, "s"), "help": (0, "help"), "version": (0, "v")}
    options, operands, _ = _getopt_long("cmp", argv, "bci:ln:sv", L)

    def usage_error(message):
        sys.stderr.write(f"cmp: {message}\ncmp: Try 'cmp --help' for more information.\n")
        raise SystemExit(2)

    print_bytes, kind, limit = False, None, -1
    skip = [0, 0]

    def specify(new):
        nonlocal kind
        if kind and kind != new:
            usage_error("options -l and -s are incompatible")
        kind = new

    def skip_value(text, f):
        value = _cmp_number(text)
        if value is None:
            usage_error(f"invalid --ignore-initial value '{text}'")
        skip[f] = max(skip[f], value)

    for key, value in options:
        if key in ("b", "c"):
            print_bytes = True
        elif key == "i":
            first, colon, second = value.partition(":")
            skip_value(first, 0)
            if colon:
                skip_value(second, 1)
            else:
                skip[1] = max(skip[1], skip[0])
        elif key == "l":
            specify("all")
        elif key == "s":
            specify("status")
        elif key == "n":
            n = _cmp_number(value)
            if n is None:
                usage_error(f"invalid --bytes value '{value}'")
            if not (0 <= limit < n):
                limit = n
        elif key == "help":
            print("Usage: cmp [OPTION]... FILE1 [FILE2 [SKIP1 [SKIP2]]]\nCompare two files byte by byte.\n\n"
                  "This is pad's cmp, which follows GNU diffutils 3.10.")
            return 0
        elif key == "v":
            print("cmp (pad, following GNU diffutils) 3.10")
            return 0
    kind = kind or "first"
    if not operands:
        usage_error(f"missing operand after '{argv[-1] if argv else 'cmp'}'")
    files = [operands[0], operands[1] if len(operands) > 1 else "-"]
    for f, text in enumerate(operands[2:4]):
        skip_value(text, f)
    if len(operands) > 4:
        usage_error(f"extra operand '{operands[4]}'")
    if files[0] == files[1] and skip[0] == skip[1]:
        return 0

    data, sizes = [], []
    for f in (0, 1):
        try:
            if files[f] == "-":
                raw = sys.stdin.buffer.read()
                st = os.fstat(0)
            else:
                with open(files[f], "rb") as handle:
                    st = os.fstat(handle.fileno())
                    raw = handle.read()
            raw = raw[skip[f]:]
        except OSError as e:
            if kind != "status":
                sys.stderr.write(f"cmp: {files[f]}: {e.strerror}\n")
            return 2
        data.append(raw)
        sizes.append(max(0, st.st_size - skip[f]) if stat.S_ISREG(st.st_mode) else None)

    if kind == "status":
        if sizes[0] is not None and sizes[1] is not None and sizes[0] != sizes[1] and (
                limit < 0 or min(sizes) < limit):
            return 1
    elif kind == "first" or kind == "all":
        # GNU says nothing at all when its output goes to /dev/null.
        try:
            out_st, null_st = os.fstat(1), os.stat(os.devnull)
            if stat.S_ISCHR(out_st.st_mode) and out_st.st_rdev and out_st.st_rdev == null_st.st_rdev:
                kind = "quiet-" + kind
        except OSError:
            pass
    d0, d1 = data
    if limit >= 0:
        d0, d1 = d0[:limit], d1[:limit]
    smaller = min(len(d0), len(d1))
    first = 0
    if d0[:smaller] != d1[:smaller]:
        lo, hi = 0, smaller   # the first differing byte, by halving
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if d0[lo:mid] != d1[lo:mid]:
                hi = mid
            else:
                lo = mid
        first = lo
    else:
        first = smaller

    def show(c):
        s = ""
        if not 32 <= c < 127:
            if c >= 128:
                s, c = "M-", c - 128
            if c < 32:
                s, c = s + "^", c + 64
            elif c == 127:
                s, c = s + "^", ord("?")
        return s + chr(c)

    out = sys.stdout
    if first < smaller:
        if kind == "status" or kind.startswith("quiet-"):
            return 1
        if kind == "first":
            line = d0.count(b"\n", 0, first) + 1
            name0, name1 = files
            if print_bytes:
                c0, c1 = d0[first], d1[first]
                out.write(f"{name0} {name1} differ: byte {first + 1}, line {line} is "
                          f"{c0:3o} {show(c0)} {c1:3o} {show(c1)}\n")
            else:
                word = "char" if _c_locale("LC_MESSAGES") else "byte"
                out.write(f"{name0} {name1} differ: {word} {first + 1}, line {line}\n")
            return 1
        width_max = limit if limit >= 0 else (1 << 63) - 1
        for size in sizes:
            if size is not None:
                width_max = min(width_max, size)
        width = len(str(width_max))
        lines = []
        for i in range(first, smaller):
            c0, c1 = d0[i], d1[i]
            if c0 != c1:
                if print_bytes:
                    lines.append(f"{i + 1:>{width}} {c0:3o} {show(c0):<4} {c1:3o} {show(c1)}\n")
                else:
                    lines.append(f"{i + 1:>{width}} {c0:3o} {c1:3o}\n")
        out.write("".join(lines))
        differing = True
    else:
        differing = False
    if len(d0) != len(d1):
        if kind != "status" and not (differing and kind.startswith("quiet-")):
            out.flush()
            shorter = files[0] if len(d0) < len(d1) else files[1]
            if smaller == 0:
                sys.stderr.write(f"cmp: EOF on {shorter} which is empty\n")
            elif kind == "first":
                newlines = d0.count(b"\n", 0, smaller)
                if d0[smaller - 1] == 10:
                    sys.stderr.write(f"cmp: EOF on {shorter} after byte {smaller}, line {newlines}\n")
                else:
                    sys.stderr.write(f"cmp: EOF on {shorter} after byte {smaller}, in line {newlines + 1}\n")
            else:
                sys.stderr.write(f"cmp: EOF on {shorter} after byte {smaller}\n")
        return 1
    return 1 if differing else 0


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
    """bzip2 and xz, by python's bz2 and lzma — which make the same bytes the tools make.

    Checked: every level, -e, and a 600 KB file all come out byte-for-byte
    what bzip2 1.0.8 and xz 5.4 write. Around that, each tool's own rules: the
    suffixes each knows (.tbz2 and .txz come back as .tar), refusing to
    overwrite without -f or to compress what already has the suffix, keeping
    the input's mode and times, and the messages and exit codes each gives —
    for xz, 1 for an error and 2 for a file it skipped.
    """
    xz = module.__name__ == "lzma"
    decompress = tool.startswith(("bun", "un"))
    keep = force = to_stdout = testing = quiet = extreme = False
    level, lzma_format, check, files, only_files = (6 if xz else 9), "xz", None, [], False
    if xz:
        longs = {"--decompress": "d", "--uncompress": "d", "--compress": "z", "--keep": "k", "--force": "f",
                 "--stdout": "c", "--to-stdout": "c", "--test": "t", "--quiet": "q", "--extreme": "e",
                 "--fast": "0", "--best": "9"}
        shorts, valued = "dzkfctqe0123456789", "TFC"
        supported = "Supported: -d -z -k -f -c -t -q -0..-9 -e -T1 -F xz|lzma -C crc32|crc64|sha256|none"
    else:
        longs = {"--decompress": "d", "--compress": "z", "--keep": "k", "--force": "f", "--stdout": "c",
                 "--test": "t", "--quiet": "q", "--small": "s", "--fast": "1", "--best": "9"}
        shorts, valued = "dzkfctqs123456789", ""
        supported = "Supported: -d -z -k -f -c -t -q -s -1..-9"
    named = {"--threads": "T", "--format": "F", "--check": "C"} if xz else {}

    def option(flag, value=None):
        nonlocal decompress, keep, force, to_stdout, testing, quiet, extreme, level, lzma_format, check
        if flag in "dz":
            decompress = flag == "d"
        elif flag == "k":
            keep = True
        elif flag == "f":
            force = True
        elif flag == "c":
            to_stdout = True
        elif flag == "t":
            testing = True
        elif flag == "q":
            quiet = True
        elif flag == "e":
            extreme = True
        elif flag.isdigit():
            level = int(flag)
        elif flag == "T":
            if value not in ("1",):
                die(tool, f"-T{value} is not supported here: the output is single-threaded, and xz's threaded output differs")
        elif flag == "F":
            if value not in ("xz", "lzma", "alone", "auto"):
                die(tool, f"--format={value} is not supported here. Supported: xz lzma")
            lzma_format = "lzma" if value == "alone" else value
        elif flag == "C":
            checks = {"crc32": module.CHECK_CRC32, "crc64": module.CHECK_CRC64, "sha256": module.CHECK_SHA256,
                      "none": module.CHECK_NONE}
            if value not in checks:
                die(tool, f"--check={value} is not supported here. Supported: crc32 crc64 sha256 none")
            check = checks[value]

    i = 0
    while i < len(argv):
        a = argv[i]
        if only_files or not a.startswith("-") or a == "-":
            files.append(a)
        elif a == "--":
            only_files = True
        elif a.startswith("--"):
            key, eq, value = a.partition("=")
            if key in longs and not eq:
                option(longs[key])
            elif key in named:
                if not eq:
                    i += 1
                    value = argv[i] if i < len(argv) else ""
                option(named[key], value)
            else:
                die(tool, f"unsupported option '{a}'. {supported}")
        else:
            for j, f in enumerate(a[1:], start=1):
                if f in valued:
                    value = a[j + 1 :]
                    if not value:
                        i += 1
                        value = argv[i] if i < len(argv) else ""
                    option(f, value)
                    break
                if f not in shorts:
                    die(tool, f"unsupported option '-{f}'. {supported}")
                option(f)
        i += 1

    worst = [0, 0]  # bzip2's highest exit code; for xz, [errors, warnings]

    def error(message, code=1):
        sys.stderr.write(f"{tool}: {message}\n")
        if xz:
            worst[0 if code == 1 else 1] = 1
        else:
            worst[0] = max(worst[0], code)

    def warning(message):
        if not quiet:
            sys.stderr.write(f"{tool}: {message}\n")
        if xz:
            worst[1] = 1

    def result():
        return (1 if worst[0] else 2 if worst[1] else 0) if xz else worst[0]

    def pack(raw):
        if xz:
            if lzma_format == "lzma":
                return module.compress(raw, format=module.FORMAT_ALONE, preset=level | (module.PRESET_EXTREME if extreme else 0))
            return module.compress(raw, check=module.CHECK_CRC64 if check is None else check,
                                   preset=level | (module.PRESET_EXTREME if extreme else 0))
        return module.compress(raw, level)

    def unpack(raw, label):
        """The data, or None having said what was wrong with it, in the tool's words."""
        recovery = ("\nYou can use the `bzip2recover' program to attempt to recover\n"
                    "data from undamaged sections of corrupted files.\n\n")
        if xz:
            try:
                return module.decompress(raw, format=module.FORMAT_ALONE if lzma_format == "lzma" else module.FORMAT_AUTO)
            except EOFError:
                error(f"{label}: Unexpected end of input")
            except module.LZMAError as e:
                error(f"{label}: {'File format not recognized' if 'format' in str(e) else 'Compressed data is corrupt'}")
            return None
        if not raw.startswith(b"BZh"):
            if testing:
                sys.stderr.write(f"{tool}: {label}: bad magic number (file not created by bzip2)\n{recovery}")
                worst[0] = max(worst[0], 2)
            else:
                error(f"{label} is not a bzip2 file.", 2)
            return None
        out, data = [], raw
        try:
            while data:
                d = module.BZ2Decompressor()
                out.append(d.decompress(data))
                if not d.eof:
                    raise EOFError
                data = d.unused_data
                if data and not data.startswith(b"BZh"):
                    warning(f"{label}: trailing garbage after EOF ignored")
                    break
        except EOFError:
            what = f"{label}: file ends unexpectedly" if testing else (
                "Compressed file ends unexpectedly;\n\tperhaps it is corrupted?  *Possible* reason follows.")
            sys.stderr.write(f"{tool}: {what}\n{recovery}")
            worst[0] = max(worst[0], 2)
            return None
        except OSError:
            what = f"{label}: data integrity (CRC) error in data" if testing else "Data integrity error when decompressing."
            sys.stderr.write(f"{tool}: {what}\n{recovery}")
            worst[0] = max(worst[0], 2)
            return None
        return b"".join(out)

    def through(raw, label):
        """(De)compress or test one input; the bytes to write, or None."""
        if testing:
            unpack(raw, label)
            return None
        return unpack(raw, label) if decompress else pack(raw)

    if not files:
        files = ["-"]
    for name in files:
        if name == "-":
            reading = decompress or testing
            if reading and sys.stdin.isatty() and not force:
                error("Compressed data cannot be read from a terminal" if xz else
                      "I won't read compressed data from a terminal.\n" f"{tool}: For help, type: `{tool} --help'.")
                continue
            if not reading and sys.stdout.isatty() and not force:
                error("Compressed data cannot be written to a terminal" if xz else
                      "I won't write compressed data to a terminal.\n" f"{tool}: For help, type: `{tool} --help'.")
                continue
            body = through(sys.stdin.buffer.read(), "(stdin)")
            if body is not None:
                sys.stdout.buffer.write(body)
            continue

        try:
            # A symlink is skipped as not a regular file, unless -f says to follow it.
            st = os.stat(name) if force else os.lstat(name)
        except OSError as e:
            error(f"{name}: {e.strerror}" if xz else f"Can't open input file {name}: {e.strerror}.")
            continue
        if stat.S_ISDIR(st.st_mode):
            warning(f"{name}: Is a directory, skipping") if xz else error(f"Input file {name} is a directory.")
            continue
        if not stat.S_ISREG(st.st_mode) and not to_stdout:
            warning(f"{name}: Not a regular file, skipping") if xz else error(f"Input file {name} is not a normal file.")
            continue
        in_place = not to_stdout and not testing
        if xz:
            known = [(".xz", ""), (".txz", ".tar")] if lzma_format == "xz" else [(".lzma", ""), (".tlz", ".tar")]
            if lzma_format == "auto" or decompress:
                known = [(".xz", ""), (".txz", ".tar"), (".lzma", ""), (".tlz", ".tar")]
            new_suffix = ".lzma" if lzma_format == "lzma" else ".xz"
        else:
            known, new_suffix = [(".bz2", ""), (".bz", ""), (".tbz2", ".tar"), (".tbz", ".tar")], suffix
        ending = next(((old, new) for old, new in known if name.endswith(old) and len(name) > len(old)), None)
        if in_place and not decompress:
            if ending and (xz or not force):
                if xz:
                    warning(f"{name}: File already has `{ending[0]}' suffix, skipping")
                else:
                    error(f"Input file {name} already has {ending[0]} suffix.")
                continue
            out_name = name + new_suffix
        elif in_place:
            out_name = name[: -len(ending[0])] + ending[1] if ending else None
        if in_place and st.st_nlink > 1 and not force:
            others = st.st_nlink - 1
            if xz:
                warning(f"{name}: Input file has more than one hard link, skipping")
            else:
                error(f"Input file {name} has {others} other link{'s' if others > 1 else ''}.")
            continue
        try:
            with open(name, "rb") as f:
                raw = f.read()
        except OSError as e:
            error(f"{name}: {e.strerror}" if xz else f"Can't open input file {name}: {e.strerror}.")
            continue
        if in_place and decompress and out_name is None and not xz:
            out_name = name + ".out"
            warning(f"Can't guess original name for {name} -- using {out_name}")
        body = through(raw, name)
        if body is None:
            continue
        if not in_place:
            sys.stdout.buffer.write(body)
            continue
        if out_name is None:
            warning(f"{name}: Filename has an unknown suffix, skipping")
            continue
        if os.path.lexists(out_name):
            if not force:
                error(f"{out_name}: File exists" if xz else f"Output file {out_name} already exists.")
                continue
            os.remove(out_name)
        with open(out_name, "wb") as f:
            f.write(body)
        keep_mode_and_times(out_name, stat.S_IMODE(st.st_mode), (st.st_atime_ns, st.st_mtime_ns))
        if not keep:
            os.remove(name)
    return result()


# ---------------------------------------------------------------- cal / rev
CAL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
              "October", "November", "December"]


def cmd_cal(argv):
    """The cal of Debian's ncal: a month, a year, -3, -A and -B, -y, -m, -1 and -d, as it lays them out.

    Each month is twenty columns and two of space, and six weeks high however
    many it has. Months go three to a row; a run that starts a quarter and
    fills a row gets the year as a heading of its own, as ncal gives it. The
    calendar is Britain's, as cal's is: September 1752 lost eleven days, and
    before them the year is Julian.
    """
    import datetime

    def usage(message=None):
        sys.stderr.write((f"cal: {message}\n" if message else "") + (
            "Usage: cal [general options] [-jy] [[month] year]\n"
            "       cal [general options] [-j] [-m month] [year]\n"
            "General options: [-31] [-A months] [-B months] [-d yyyy-mm]\n"))
        raise SystemExit(64)

    def fail(message):
        sys.stderr.write(f"cal: {message}\n")
        raise SystemExit(64)

    today = datetime.date.today()
    year, month = today.year, today.month
    before = after = 0
    three = whole = False
    flag_month, operands, i = None, [], 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            operands.extend(argv[i + 1 :])
            break
        if not a.startswith("-") or a == "-":
            operands.append(a)
            i += 1
            continue
        for j, f in enumerate(a[1:], start=1):
            if f in "ABdm":
                value = a[j + 1 :]
                if not value:
                    i += 1
                    if i >= len(argv):
                        usage(f"option requires an argument -- '{f}'")
                    value = argv[i]
                if f in "AB":
                    count = max(0, c_number(value)[0] or 0)  # strtol, as ncal reads it
                    before, after = (count, after) if f == "B" else (before, count)
                elif f == "m":
                    flag_month = value
                else:
                    parts = value.split("-")
                    if len(parts) != 2 or not all(p.isdigit() for p in parts):
                        fail(f"invalid date {value}")
                    # mktime's arithmetic: month 13 of 2026 is January 2027.
                    year, month = int(parts[0]) + (int(parts[1]) - 1) // 12, (int(parts[1]) - 1) % 12 + 1
                break
            if f == "3":
                three = True
            elif f == "1":
                three = False
            elif f == "y":
                whole = True
            elif f == "j":
                die("cal", "unsupported option '-j'. Supported: -1 -3 -A N -B N -d YYYY-MM -m MONTH -y")
            else:
                usage(f"invalid option -- '{f}'")
        i += 1
    if len(operands) > 2:
        usage()
    if operands:
        text = operands[-1]
        if not text.isdigit():
            fail(f"not a valid year {text}")
        year = int(text)
        if not 1 <= year <= 9999:
            fail(f"year `{text}' not in range 1..9999")
        if len(operands) == 2:
            flag_month = operands[0]
        elif flag_month is None:
            whole = True
    if flag_month is not None:
        # With a year given, ncal has no current month to compare 2f and 2p with: it is 0.
        month, year = cal_month(flag_month, 0 if operands else month, year, fail)
    if whole:
        month, before, after = 1, 0, 11
    elif three:
        before, after = before + 1, after + 1

    first = year * 12 + month - 1 - before
    last = year * 12 + month - 1 + after
    heading = last - first + 1 >= 3 and first % 3 == 0
    lines, shown_year = [], None
    for start in range(first, last + 1, 3):
        row = list(range(start, min(start + 3, last + 1)))
        if heading and start // 12 != shown_year:
            shown_year = start // 12
            lines.append(" " * ((60 - len(str(shown_year))) // 2) + str(shown_year))
        names = []
        for index in row:
            name = CAL_MONTHS[index % 12] if heading else f"{CAL_MONTHS[index % 12]} {index // 12}"
            names.append((" " * ((20 - len(name)) // 2) + name).ljust(20) + "  ")
        lines.append("".join(names))
        lines.append("Su Mo Tu We Th Fr Sa  " * len(row))
        weeks = [cal_weeks(index // 12, index % 12 + 1) for index in row]
        for week in range(6):
            lines.append("".join(w[week] + "  " for w in weeks))
        if start + 3 <= last:
            lines.append("")
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


def cal_month(text, month, year, fail):
    """ncal's parsemonth(): 1..12, with f or p for the next or last such month; or a month's name or its start."""
    digits = text.rstrip("fFpP")
    if digits.isdigit() and len(text) - len(digits) <= 1:
        number, mark = int(digits), text[len(digits) :].lower()
        if 1 <= number <= 12:
            if mark == "f" and number <= month:
                year += 1
            elif mark == "p" and number >= month:
                year -= 1
            return number, year
    else:
        lowered = text.lower()
        for index, name in enumerate(CAL_MONTHS):
            if lowered.startswith(name.lower()) or lowered.startswith(name[:3].lower()):
                return index + 1, year
    fail(f"{text} is neither a month number (1..12) nor a name")


def cal_weeks(year, month):
    """A month's six rows of days, Sunday first, by the calendar Britain kept."""
    def julian_day(y, m, d):
        a = (14 - m) // 12
        y2, m2 = y + 4800 - a, m + 12 * a - 3
        day = d + (153 * m2 + 2) // 5 + 365 * y2 + y2 // 4
        if (y, m, d) < (1752, 9, 14):
            return day - 32083
        return day - y2 // 100 + y2 // 400 - 32045

    leap = year % 4 == 0 if year <= 1752 else (year % 4 == 0 and year % 100 != 0) or year % 400 == 0
    length = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    days = [d for d in range(1, length + 1) if not ((year, month) == (1752, 9) and 3 <= d <= 13)]
    cells = ["  "] * ((julian_day(year, month, 1) + 1) % 7) + [f"{d:2d}" for d in days]
    cells += ["  "] * (42 - len(cells))
    return [" ".join(cells[k : k + 7]) for k in range(0, 42, 7)]


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
