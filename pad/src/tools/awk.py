"""
A small awk, written in Python, because no awk exists for this runtime.

grep, sed and find are real ports from the registry. awk is not published
anywhere reachable — `wasmer/gawk`, `wasmer/mawk`, `wasmer/goawk`,
`wasmer/busybox` and a dozen other guesses all return nothing, and the
registry's own search endpoint returns nothing for *any* query, including
`python`, so there is no way to look properly.

This covers what awk is actually used for at a prompt: fields, `NR`, `NF`,
`-F`, `-v`, patterns, `BEGIN`/`END`, `print` and `printf`. It is not awk. It
refuses what it does not understand instead of quietly doing something else,
which is the only honest way to ship a partial implementation of a language
someone already knows.

Shipped as a string so it lands in the sandbox with everything else and
needs no second fetch.
"""
import operator, os, re, sys

USAGE = "usage: awk [-F sep] [-v var=value] 'program' [file ...]"

class Unsupported(Exception):
    pass

def die(msg, code=2):
    sys.stderr.write("awk: " + msg + "\n")
    sys.exit(code)

# ---------------------------------------------------------------- parsing
#
# A program is a list of (pattern, action). Either may be absent: a bare
# pattern prints the line, a bare action runs on every line.

def split_rules(program):
    rules, i, n = [], 0, len(program)
    while i < n:
        while i < n and program[i] in " \t\n;":
            i += 1
        if i >= n:
            break
        start = i
        depth, in_str, in_re = 0, None, False
        while i < n:
            c = program[i]
            if in_str:
                if c == "\\":
                    i += 2
                    continue
                if c == in_str:
                    in_str = None
            elif in_re:
                if c == "\\":
                    i += 2
                    continue
                if c == "/":
                    in_re = False
            elif c in "\"'":
                in_str = c
            elif c == "/" and _regex_may_start(program, i):
                in_re = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            elif c in "\n;" and depth == 0:
                break
            i += 1
        chunk = program[start:i].strip()
        if chunk:
            rules.append(chunk)
    return rules

def _regex_may_start(s, i):
    # A slash begins a regex only where a value could begin. After a name, a
    # number or a closing bracket it is division.
    j = i - 1
    while j >= 0 and s[j] in " \t":
        j -= 1
    return j < 0 or s[j] not in ")]0123456789" and not (s[j].isalnum() or s[j] == "_")

def parse_rule(rule):
    if rule.startswith("BEGIN"):
        return ("BEGIN", _body(rule[5:]))
    if rule.startswith("END"):
        return ("END", _body(rule[3:]))
    brace = _top_level_brace(rule)
    if brace is None:
        return (rule.strip(), "print")
    pattern = rule[:brace].strip()
    return (pattern or None, _body(rule[brace:]))

def _body(text):
    text = text.strip()
    if not text.startswith("{") or not text.endswith("}"):
        raise Unsupported("expected a { action } block, got: " + text[:40])
    return text[1:-1].strip()

def _top_level_brace(rule):
    in_str, in_re = None, False
    for i, c in enumerate(rule):
        if in_str:
            if c == in_str:
                in_str = None
        elif in_re:
            if c == "/":
                in_re = False
        elif c in "\"'":
            in_str = c
        elif c == "/" and _regex_may_start(rule, i):
            in_re = True
        elif c == "{":
            return i
    return None

# ------------------------------------------------------------- evaluation
#
# Expressions are translated to Python rather than interpreted. The grammar
# awk and Python share is large enough to make that worth doing, and anything
# outside it is refused by `guard` rather than mistranslated.

FORBIDDEN = re.compile(r"\b(import|exec|eval|open|__\w+__|lambda|global)\b")

def guard(expr):
    if FORBIDDEN.search(expr):
        raise Unsupported("not supported here: " + expr[:40])
    return expr

def to_python(expr):
    guard(expr)
    out, i, n = "", 0, len(expr)
    while i < n:
        c = expr[i]
        if c in "\"'":
            j = i + 1
            while j < n and expr[j] != c:
                j += 2 if expr[j] == "\\" else 1
            # A string constant: text, which joins with `|` (below).
            out += "T(" + expr[i : j + 1] + ")"
            i = j + 1
            continue
        if c == "$":
            j = i + 1
            if j < n and expr[j] == "(":
                depth, k = 1, j + 1
                while k < n and depth:
                    depth += (expr[k] == "(") - (expr[k] == ")")
                    k += 1
                out += "F(" + to_python(expr[j + 1 : k - 1]) + ")"
                i = k
            else:
                while j < n and (expr[j].isalnum() or expr[j] == "_"):
                    j += 1
                out += "F(" + expr[i + 1 : j] + ")"
                i = j
            continue
        if c == "/" and _regex_may_start(expr, i):
            j = i + 1
            while j < n and expr[j] != "/":
                j += 2 if expr[j] == "\\" else 1
            body = repr(expr[i + 1 : j])
            # Decided here, where the context is known, rather than by a later
            # substitution. A regex that is not an operand of `~` or `!~` means
            # "does this line match" — and a post-hoc rewrite cannot tell the
            # difference without a lookahead that non-greedy backtracking then
            # walks straight past, swallowing the whole expression.
            operand = out.rstrip().endswith(("MATCHES", "NOTMATCH"))
            out += ("RE(" + body + ")") if operand else ("M(" + body + ")")
            i = j + 1
            continue
        if expr.startswith("!~", i):
            out += " NOTMATCH "
            i += 2
            continue
        if c == "~":
            out += " MATCHES "
            i += 1
            continue
        if expr.startswith("&&", i):
            out += " and "; i += 2; continue
        if expr.startswith("||", i):
            out += " or "; i += 2; continue
        if c == "!" and not expr.startswith("!=", i) and not expr.startswith("!~", i):
            out += " not "; i += 1; continue
        out += c
        i += 1
    # `!~` is turned into a call after the fact, which keeps the scanner simple.
    # awk concatenates adjacent values with no operator between them:
    # `$1 "-" $3`. Python is given `|`, which a field and a string constant
    # take as joining (`Field.__or__`), and which sits where awk's joining
    # does: below `+`, so `$1 " " $2+1` adds before it joins, and above the
    # comparisons. It was `+`, which became addition once fields added as
    # numbers. Only inserted where both sides are plainly values — a field,
    # a call, or a string constant — so the keywords this translation emits
    # (`and`, `or`, `not`, `is`) are never joined.
    # And the markers `~` and `!~` become, which the lines below rewrite.
    keyword = r"(?:and|or|not|is|in|None|True|False|MATCHES|NOTMATCH)\b"
    out = re.sub(
        r"(?P<left>\)|\b(?!" + keyword + r")[A-Za-z_]\w*(?<!\bF)(?<!\bM)(?<!\bRE)(?<!\bT))\s+(?=(?!" + keyword + r")[A-Za-z_]\w*\b(?!\s*=)|(?:F|M|RE|T)\()",
        r"\g<left> | ",
        out,
    )
    out = re.sub(r"(\S+)\s+NOTMATCH\s+RE\((.+?)\)", r"(RE(\2).search(str(\1)) is None)", out)
    out = re.sub(r"(\S+)\s+MATCHES\s+RE\((.+?)\)", r"(RE(\2).search(str(\1)) is not None)", out)
    # And against a string, which awk takes as a regular expression too:
    # `$2 ~ "o"`.
    out = re.sub(r"(\S+)\s+NOTMATCH\s+T\((.+?)\)", r"(RE(\2).search(str(\1)) is None)", out)
    out = re.sub(r"(\S+)\s+MATCHES\s+T\((.+?)\)", r"(RE(\2).search(str(\1)) is not None)", out)
    return out

class Runner:
    def __init__(self, fs, ofs, variables):
        self.fields = [""]
        self.vars = dict(variables)
        self.vars.setdefault("FS", fs)
        self.vars.setdefault("OFS", ofs)
        self.vars.setdefault("NR", 0)
        self.vars.setdefault("NF", 0)
        self.cache = {}

    def env(self):
        def F(i):
            i = int(i)
            return Field(self.fields[i]) if 0 <= i < len(self.fields) else Field("")
        def RE(p):
            if p not in self.cache:
                self.cache[p] = re.compile(p)
            return self.cache[p]
        # A variable never set is "" (and 0), as in awk: `s = s $1` from the
        # first line on.
        scope = Unset(self.vars)
        scope["F"] = F
        scope["RE"] = RE
        # A bare regex: does the whole line match. Left as a pattern object it
        # would simply be truthy and every line would pass.
        scope["M"] = lambda p: RE(p).search(self.fields[0]) is not None
        scope["length"] = len
        scope["substr"] = lambda s, m, n=None: Field(str(s)[int(_awknum(m)) - 1 : (int(_awknum(m)) - 1 + int(_awknum(n))) if n is not None else None])
        scope["index"] = lambda s, t: str(s).find(str(t)) + 1
        scope["split"] = lambda s, _a, sep=None: len(str(s).split(sep))
        scope["toupper"] = lambda s: Field(str(s).upper())
        scope["tolower"] = lambda s: Field(str(s).lower())
        scope["int"] = lambda v: int(_awknum(v))
        scope["T"] = Text
        # The evaluation scope has no builtins, deliberately — but the
        # rewrites above emit `str(...)`, so it has to be handed back in.
        scope["str"] = str
        scope["float"] = float
        return scope

    def set_line(self, line):
        self.fields = [line]
        fs = str(self.vars["FS"])
        # awk's rule: a single space is runs of blanks, one other character is
        # itself, and anything longer is a regular expression — `-F '[,:]'`
        # split nothing and gave an empty $2 (audit R4).
        if fs == " ":
            parts = line.split()
        elif len(fs) == 1:
            parts = line.split(fs)
        else:
            try:
                parts = re.split(fs, line)
            except re.error as e:
                raise Unsupported("field separator " + fs + " is not a regular expression this awk reads (" + str(e) + ")")
        parts = [Field(p) for p in parts]
        self.fields += parts
        self.vars["NF"] = len(parts)

    def test(self, pattern):
        if pattern is None:
            return True
        try:
            return bool(eval(to_python(pattern), {"__builtins__": {}}, self.env()))
        except Unsupported:
            raise
        except Exception as e:
            raise Unsupported("cannot evaluate pattern " + pattern[:40] + " (" + str(e) + ")")

    def run(self, action, out):
        for statement in _statements(action):
            self.statement(statement, out)

    def statement(self, s, out):
        s = s.strip()
        if not s:
            return
        if s == "print":
            out.write(self.fields[0] + "\n")
            return
        if s.startswith("print "):
            parts = _commas(s[6:])
            joined = str(self.vars["OFS"]).join(_shown(self.value(p)) for p in parts)
            out.write(joined + "\n")
            return
        if s.startswith("printf "):
            parts = _commas(s[7:])
            fmt = self.value(parts[0])
            out.write(str(fmt) % tuple(self.value(p) for p in parts[1:]))
            return
        m = re.match(r"^([A-Za-z_]\w*)\s*(\+=|-=|=)\s*(.+)$", s)
        if m:
            name, op, rhs = m.groups()
            value = self.value(rhs)
            if op == "+=":
                value = _num(self.vars.get(name, 0)) + _num(value)
            elif op == "-=":
                value = _num(self.vars.get(name, 0)) - _num(value)
            self.vars[name] = value
            return
        m = re.match(r"^([A-Za-z_]\w*)\+\+$", s)
        if m:
            self.vars[m.group(1)] = _num(self.vars.get(m.group(1), 0)) + 1
            return
        raise Unsupported("statement not supported: " + s[:40])

    def value(self, expr):
        expr = expr.strip()
        try:
            return eval(to_python(expr), {"__builtins__": {}}, self.env())
        except Unsupported:
            raise
        except Exception as e:
            raise Unsupported("cannot evaluate " + expr[:40] + " (" + str(e) + ")")

def _looks_numeric(v):
    try:
        float(str(v))
        return True
    except (TypeError, ValueError):
        return False

class Field(str):
    """
    A field, which is a string that compares as a number when it can.

    awk's own rule: input that looks numeric compares numerically and prints
    exactly as it arrived. A plain `str` gets `$3 > 20` wrong — it compares
    character by character, so "9" is greater than "20" — and a plain number
    loses the original text, so "007" prints as 7.
    """

    def _compare(self, other, op):
        if _looks_numeric(self) and _looks_numeric(other):
            return op(float(self), float(other))
        return op(str(self), str(other))

    def __lt__(self, other):
        return self._compare(other, operator.lt)

    def __le__(self, other):
        return self._compare(other, operator.le)

    def __gt__(self, other):
        return self._compare(other, operator.gt)

    def __ge__(self, other):
        return self._compare(other, operator.ge)

    def __eq__(self, other):
        return self._compare(other, operator.eq)

    def __ne__(self, other):
        return not self.__eq__(other)

    def __hash__(self):
        return str.__hash__(self)

    # Arithmetic is on numbers, always, as in awk. Inherited from `str`, `+`
    # joined and `*` repeated: `$1 + $2` on "3 4" printed 34 and `$1 * 2`
    # printed 33, both exiting 0 (audit R1). Joining is juxtaposition in awk,
    # which the translation writes with str() — never with these.
    def __add__(self, other):
        return _arith(operator.add, self, other)

    def __radd__(self, other):
        return _arith(operator.add, other, self)

    def __sub__(self, other):
        return _arith(operator.sub, self, other)

    def __rsub__(self, other):
        return _arith(operator.sub, other, self)

    def __mul__(self, other):
        return _arith(operator.mul, self, other)

    def __rmul__(self, other):
        return _arith(operator.mul, other, self)

    def __truediv__(self, other):
        return _arith(operator.truediv, self, other)

    def __rtruediv__(self, other):
        return _arith(operator.truediv, other, self)

    def __mod__(self, other):
        return _arith(_fmod, self, other)

    def __rmod__(self, other):
        return _arith(_fmod, other, self)

    def __pow__(self, other):
        return _arith(operator.pow, self, other)

    def __rpow__(self, other):
        return _arith(operator.pow, other, self)

    def __neg__(self):
        return _tidy(-_awknum(self))

    def __pos__(self):
        return _tidy(_awknum(self))

    # Joining, awk's juxtaposition, as the translation writes it: a string.
    def __or__(self, other):
        return Text(_shown(self) + _shown(other))

    def __ror__(self, other):
        return Text(_shown(other) + _shown(self))

class Unset(dict):
    """The evaluation scope: what was never set reads as empty text."""

    def __missing__(self, name):
        return Text("")

class Text(Field):
    """A string constant, or what joining made: text, compared as text."""

    def _compare(self, other, op):
        return op(str(self), _shown(other))

_NUMERIC_PREFIX = re.compile(r"^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?")

def _awknum(v):
    """A value as awk reads a number from it: its leading number, or 0."""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return v
    m = _NUMERIC_PREFIX.match(str(v))
    if not m:
        return 0
    f = float(m.group(0))
    return int(f) if f.is_integer() and "e" not in m.group(0).lower() and "." not in m.group(0) else f

def _tidy(v):
    return int(v) if isinstance(v, float) and v.is_integer() and abs(v) < 2**53 else v

def _fmod(a, b):
    import math
    return math.fmod(a, b)

def _arith(op, a, b):
    try:
        return _tidy(op(_awknum(a), _awknum(b)))
    except ZeroDivisionError:
        raise Unsupported("division by zero")

def _shown(v):
    """A value as print shows it: a number as awk's %.6g, an integral one whole."""
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() and abs(v) < 1e16 else "%.6g" % v
    return str(v)

def _num(v):
    try:
        f = float(v)
        return int(f) if f == int(f) else f
    except (TypeError, ValueError):
        return 0

def _statements(action):
    return [p for p in _split_top(action, ";") if p.strip()]

def _commas(text):
    return [p for p in _split_top(text, ",") if p.strip()]

def _split_top(text, sep):
    parts, depth, in_str, cur = [], 0, None, ""
    for c in text:
        if in_str:
            cur += c
            if c == in_str:
                in_str = None
            continue
        if c in "\"'":
            in_str = c
        elif c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        if c == sep and depth == 0:
            parts.append(cur)
            cur = ""
            continue
        cur += c
    parts.append(cur)
    return parts

# ------------------------------------------------------------------- main

def main(argv):
    fs, ofs, variables, program, files = " ", " ", {}, None, []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "-F":
            i += 1
            fs = argv[i]
        elif a.startswith("-F"):
            fs = a[2:]
        elif a == "-v":
            i += 1
            k, _, v = argv[i].partition("=")
            # A field's kind of value: a number when it looks like one.
            variables[k] = Field(v)
        elif a == "--help":
            print(USAGE)
            return 0
        elif program is None:
            program = a
        else:
            files.append(a)
        i += 1
    if program is None:
        die(USAGE)
    if fs == "\\t":
        fs = "\t"

    try:
        rules = [parse_rule(r) for r in split_rules(program)]
    except Unsupported as e:
        die(str(e))

    runner = Runner(fs, ofs, variables)
    out = sys.stdout
    try:
        for pattern, action in rules:
            if pattern == "BEGIN":
                runner.run(action, out)

        if any(p not in ("BEGIN",) for p, _ in rules):
            streams = [open(f) for f in files] if files else [sys.stdin]
            for stream in streams:
                for line in stream:
                    line = line.rstrip("\n")
                    runner.vars["NR"] = runner.vars["NR"] + 1
                    runner.set_line(line)
                    for pattern, action in rules:
                        if pattern in ("BEGIN", "END"):
                            continue
                        if runner.test(pattern):
                            runner.run(action, out)
                if stream is not sys.stdin:
                    stream.close()

        for pattern, action in rules:
            if pattern == "END":
                runner.run(action, out)
    except Unsupported as e:
        die(str(e))
    except BrokenPipeError:
        return 0
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
