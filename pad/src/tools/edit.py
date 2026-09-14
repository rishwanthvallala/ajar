"""A small full-screen editor, because no editor is published for this runtime.

`nano` and `vim` exist only inside packages the SDK cannot install, and
`curses` imports here but `initscr()` fails — there is no terminfo database. So
this is written straight against ANSI escapes, which is how `kilo` and every
other small editor is built.

The primitives were checked before a line of this was written:

    shutil.get_terminal_size()  -> 80x24   the pty reports a real size
    sys.stdin.isatty()          -> True
    tty.setraw()                -> works
    sys.stdin.read(1)           -> returns one byte, unbuffered
    ANSI cursor escapes         -> reach the terminal

## One constraint worth knowing

**ctrl-c never arrives.** The page intercepts it and tears the shell down,
because a shell that survives an interrupt here does not exist — see
`console.ts`. So ctrl-x is the only way out, which is nano's key anyway, and
nothing in here is bound to ctrl-c.

Keys follow nano, because `nano` is what people type. What is not implemented
is absent rather than approximated: there is no syntax highlighting, no undo,
no multiple buffers, and no line wrapping.
"""

import os
import sys
import termios
import tty

ESC = "\x1b"


class Screen:
    """Raw mode and the alternate buffer, restored no matter how we leave."""

    def __init__(self):
        self.fd = sys.stdin.fileno()
        self.saved = None

    def __enter__(self):
        try:
            self.saved = termios.tcgetattr(self.fd)
            tty.setraw(self.fd)
        except (termios.error, OSError):
            self.saved = None
        # Alternate buffer, so whatever was on screen comes back on exit.
        sys.stdout.write(f"{ESC}[?1049h{ESC}[2J")
        sys.stdout.flush()
        return self

    def __exit__(self, *_):
        sys.stdout.write(f"{ESC}[?1049l")
        sys.stdout.flush()
        if self.saved is not None:
            try:
                termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)
            except (termios.error, OSError):
                pass
        return False

    @staticmethod
    def size():
        try:
            columns, rows = os.get_terminal_size()
            return max(rows, 4), max(columns, 20)
        except OSError:
            return 24, 80


def read_key():
    """One keypress, with escape sequences folded into names.

    Arrow keys arrive as three bytes in one write, so reading them one at a
    time is safe — they are already in the pipe. A lone Escape would block
    waiting for the rest, which is why nothing here is bound to it.
    """
    ch = sys.stdin.read(1)
    if ch != ESC:
        return ch
    a = sys.stdin.read(1)
    if a not in ("[", "O"):
        return ESC
    b = sys.stdin.read(1)
    simple = {"A": "up", "B": "down", "C": "right", "D": "left", "H": "home", "F": "end"}
    if b in simple:
        return simple[b]
    if b.isdigit():
        rest = b
        while True:
            more = sys.stdin.read(1)
            if more == "~" or not more:
                break
            rest += more
        return {"1": "home", "3": "delete", "4": "end", "5": "pgup", "6": "pgdn"}.get(rest, "")
    return ""


class Editor:
    def __init__(self, path):
        self.path = path
        self.lines = [""]
        self.row = self.col = 0
        self.top = 0
        self.dirty = False
        self.message = ""
        self.cut = []
        self.existed = False
        if path and os.path.exists(path):
            self.existed = True
            with open(path, "r", errors="surrogateescape") as f:
                self.lines = f.read().split("\n") or [""]
            if self.lines and self.lines[-1] == "":
                self.lines.pop() or None
            if not self.lines:
                self.lines = [""]

    # ------------------------------------------------------------ drawing
    def draw(self, rows, columns):
        body = rows - 3
        if self.row < self.top:
            self.top = self.row
        if self.row >= self.top + body:
            self.top = self.row - body + 1

        out = [f"{ESC}[H{ESC}[2J"]
        name = self.path or "New Buffer"
        head = f"  edit   {name}{'  Modified' if self.dirty else ''}"
        out.append(f"{ESC}[7m{head[:columns].ljust(columns)}{ESC}[0m\r\n")

        for index in range(body):
            line_no = self.top + index
            text = self.lines[line_no][:columns] if line_no < len(self.lines) else "~"
            out.append(text + "\r\n")

        status = self.message or f"line {self.row + 1}/{len(self.lines)}  col {self.col + 1}"
        out.append(f"{ESC}[7m{status[:columns].ljust(columns)}{ESC}[0m\r\n")
        keys = "^O Save   ^X Exit   ^K Cut   ^U Paste   ^W Search   ^G Help"
        out.append(keys[:columns])

        screen_row = self.row - self.top + 2
        out.append(f"{ESC}[{screen_row};{min(self.col, columns - 1) + 1}H")
        sys.stdout.write("".join(out))
        sys.stdout.flush()

    def prompt(self, question, rows, columns):
        answer = ""
        while True:
            sys.stdout.write(f"{ESC}[{rows};1H{ESC}[7m{(question + answer)[:columns].ljust(columns)}{ESC}[0m")
            sys.stdout.flush()
            key = read_key()
            if key in ("\r", "\n"):
                return answer
            if key in ("\x03", "\x07"):          # ^G cancels, like nano
                return None
            if key in ("\x7f", "\b"):
                answer = answer[:-1]
            elif len(key) == 1 and key >= " ":
                answer += key

    # ------------------------------------------------------------- actions
    def save(self, rows, columns):
        path = self.path
        if not path:
            path = self.prompt("File name to write: ", rows, columns)
            if not path:
                self.message = "Cancelled"
                return
        try:
            with open(path, "w", errors="surrogateescape") as f:
                f.write("\n".join(self.lines) + "\n")
        except OSError as e:
            self.message = f"Could not write {path}: {e.strerror}"
            return
        self.path = path
        self.dirty = False
        self.message = f"Wrote {len(self.lines)} line{'' if len(self.lines) == 1 else 's'}"

    def search(self, rows, columns):
        needle = self.prompt("Search: ", rows, columns)
        if not needle:
            return
        for offset in range(1, len(self.lines) + 1):
            at = (self.row + offset) % len(self.lines)
            found = self.lines[at].find(needle)
            if found >= 0:
                self.row, self.col = at, found
                self.message = ""
                return
        self.message = f'"{needle}" not found'

    def help(self):
        self.message = "^O write  ^X quit  ^K cut line  ^U paste  ^W search  arrows move  ^G this"

    def insert(self, ch):
        line = self.lines[self.row]
        self.lines[self.row] = line[: self.col] + ch + line[self.col :]
        self.col += len(ch)
        self.dirty = True

    def newline(self):
        line = self.lines[self.row]
        self.lines[self.row : self.row + 1] = [line[: self.col], line[self.col :]]
        self.row += 1
        self.col = 0
        self.dirty = True

    def backspace(self):
        if self.col:
            line = self.lines[self.row]
            self.lines[self.row] = line[: self.col - 1] + line[self.col :]
            self.col -= 1
            self.dirty = True
        elif self.row:
            joined = len(self.lines[self.row - 1])
            self.lines[self.row - 1] += self.lines.pop(self.row)
            self.row -= 1
            self.col = joined
            self.dirty = True

    def delete(self):
        line = self.lines[self.row]
        if self.col < len(line):
            self.lines[self.row] = line[: self.col] + line[self.col + 1 :]
            self.dirty = True
        elif self.row + 1 < len(self.lines):
            self.lines[self.row] += self.lines.pop(self.row + 1)
            self.dirty = True

    def move(self, key, body):
        if key == "up" and self.row:
            self.row -= 1
        elif key == "down" and self.row + 1 < len(self.lines):
            self.row += 1
        elif key == "left":
            if self.col:
                self.col -= 1
            elif self.row:
                self.row -= 1
                self.col = len(self.lines[self.row])
        elif key == "right":
            if self.col < len(self.lines[self.row]):
                self.col += 1
            elif self.row + 1 < len(self.lines):
                self.row += 1
                self.col = 0
        elif key == "home":
            self.col = 0
        elif key == "end":
            self.col = len(self.lines[self.row])
        elif key == "pgup":
            self.row = max(0, self.row - body)
        elif key == "pgdn":
            self.row = min(len(self.lines) - 1, self.row + body)
        self.col = min(self.col, len(self.lines[self.row]))

    # ---------------------------------------------------------------- loop
    def run(self):
        with Screen():
            while True:
                rows, columns = Screen.size()
                self.draw(rows, columns)
                key = read_key()
                self.message = ""
                body = rows - 3

                if key == "\x18":                                   # ^X
                    if self.dirty:
                        answer = self.prompt("Save modified buffer? (y/n) ", rows, columns)
                        if answer is None:
                            continue
                        if answer[:1].lower() == "y":
                            self.save(rows, columns)
                            if self.dirty:
                                continue
                    return 0
                if key == "\x0f":                                   # ^O
                    self.save(rows, columns)
                elif key == "\x17":                                 # ^W
                    self.search(rows, columns)
                elif key == "\x07":                                 # ^G
                    self.help()
                elif key == "\x0b":                                 # ^K
                    if self.lines:
                        self.cut = [self.lines.pop(self.row)]
                        if not self.lines:
                            self.lines = [""]
                        self.row = min(self.row, len(self.lines) - 1)
                        self.col = 0
                        self.dirty = True
                elif key == "\x15":                                 # ^U
                    for line in reversed(self.cut):
                        self.lines.insert(self.row, line)
                    self.dirty = bool(self.cut)
                elif key in ("up", "down", "left", "right", "home", "end", "pgup", "pgdn"):
                    self.move(key, body)
                elif key in ("\r", "\n"):
                    self.newline()
                elif key in ("\x7f", "\b"):
                    self.backspace()
                elif key == "delete":
                    self.delete()
                elif key == "\t":
                    self.insert("    ")
                elif len(key) == 1 and key >= " ":
                    self.insert(key)


def main(argv):
    paths = [a for a in argv if not a.startswith("-")]
    if any(a in ("-h", "--help") for a in argv):
        print("usage: edit [file]\n  ^O write   ^X quit   ^K cut   ^U paste   ^W search")
        return 0
    if len(paths) > 1:
        sys.stderr.write("edit: one file at a time\n")
        return 2
    if not sys.stdin.isatty():
        sys.stderr.write("edit: needs a terminal\n")
        return 2
    return Editor(paths[0] if paths else None).run()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
