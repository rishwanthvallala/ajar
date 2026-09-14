/**
 * Candidate packages, and what each has to do to earn its megabytes.
 *
 * ## Why this is data
 *
 * Adding a binary should be one entry here, not a new test file. The registry
 * publishes far more than this pad ships, its own search returns nothing for
 * any query, and its size and download metadata are largely null — so the only
 * way to know whether a package is worth having is to install it and run it.
 * This is that list.
 *
 * ## Writing a test
 *
 * `run` is a bash script. `want` is compared after trimming both sides;
 * `match` is a regular expression for output that carries a version or a path.
 * Prefer `want` — an exact answer catches a tool that runs but is subtly
 * broken, which a version string never will.
 *
 * Expectations are the tool's own documented behaviour, not whatever it
 * happened to print here. A test written from observed output cannot fail.
 *
 * ## Two constraints
 *
 * `run` must be a single line. The shell detects a command's end by appending
 * a sentinel to the same line, so an embedded newline splits the command from
 * its sentinel and the result is read as a hang. Use `;` and `\\n` escapes.
 *
 * A test for one tool must not pipe through another unverified tool. The
 * shipped `sort` is broken, and piping through it made `find`, `tar` and
 * `xargs` all look broken too.
 */

export interface Check {
  run: string;
  want?: string;
  match?: string;
  /**
   * The capability this exercises, in the user's words: "recursive", "-i",
   * "in place". A package that half-works is worse than one that is absent,
   * because it fails later and somewhere else — so the report names what
   * works rather than counting passes.
   */
  covers: string;
  /** Allowed to fail without failing the package — see `curl` below. */
  optional?: boolean;
  /** Shorter for anything known to hang; the default wait is 90s. */
  timeoutMs?: number;
  why?: string;
}

export interface Candidate {
  /** Registry name, exactly as `packages.load` wants it. */
  name: string;
  /** What a user would say they gained. */
  gives: string;
  /** Skipped unless --all: big enough to be its own first-load decision. */
  heavy?: boolean;
  /** Already shipped, so a regression here is a live problem, not a proposal. */
  shipped?: boolean;
  /** This package supplies the shell itself. */
  isShell?: boolean;
  /** Extra packages to install alongside, by registry name. */
  with?: string[];
  /**
   * Shipped packages to leave out. Only for a candidate proposed as a
   * *replacement*: installed next to the thing it would replace, it proves
   * nothing about whether it could stand in for it.
   */
  without?: string[];
  checks: Check[];
}

export const CANDIDATES: Candidate[] = [
  // A control, not a candidate. Installs exactly what the product installs, so
  // a disagreement between this and the product means the harness is wrong.
  {
    name: "__shipped__",
    gives: "control — the shipped set, unmodified",
    shipped: true,
    checks: [
      { covers: "seeded file readable", run: "cat seed.txt", want: "seeded" },
      { covers: "shell redirect then read", run: "echo hi > f.txt && cat f.txt", want: "hi" },
      { covers: "working directory", run: "pwd", want: "/workspace" },
      { covers: "python write visible to the shell", run: "python3 -c \"open('cv.txt','w').write('seen')\"; cat cv.txt", want: "seen" },
      // The python-backed shims, which only exist once Shell.open has run.
      { covers: "sort (shim)", run: "printf 'b\\na\\nc\\n' | sort", want: "a\nb\nc" },
      { covers: "sort -n (shim)", run: "printf '10\\n2\\n' | sort -n", want: "2\n10" },
      { covers: "sort -r (shim)", run: "printf 'a\\nb\\n' | sort -r", want: "b\na" },
      { covers: "sort -u (shim)", run: "printf 'a\\na\\nb\\n' | sort -u", want: "a\nb" },
      { covers: "sort a file (shim)", run: "printf 'b\\na\\n' > sf.txt; sort sf.txt", want: "a\nb" },
      { covers: "sort -k (shim)", run: "printf 'x 2\\ny 1\\n' | sort -k 2", want: "y 1\nx 2" },
      { covers: "tail -n (shim)", run: "printf '1\\n2\\n3\\n' | tail -n 1", want: "3" },
      { covers: "tail -1 legacy (shim)", run: "printf '1\\n2\\n3\\n' | tail -1", want: "3" },
      { covers: "tail -n +2 (shim)", run: "printf '1\\n2\\n3\\n' | tail -n +2", want: "2\n3" },
      { covers: "tail a file (shim)", run: "printf '1\\n2\\n' > tf.txt; tail -n 1 tf.txt", want: "2" },
      { covers: "ls | sort, the thing that was broken", run: "mkdir -p q && touch q/b q/a; ls q | sort", want: "a\nb" },
      { covers: "awk still works", run: "printf '1 2\\n' | awk '{print $2}'", want: "2" },
      // The five added later. These pass as candidates too; here they prove
      // they are in the set a visitor actually gets, not merely installable.
      { covers: "jq is present", run: "echo '{\"a\":1}' | jq -r .a", want: "1" },
      { covers: "gzip is present", run: "echo g > gz.txt && gzip gz.txt && gunzip gz.txt.gz && cat gz.txt", want: "g" },
      { covers: "tar is present", run: "mkdir -p tp && echo t > tp/f && tar cf tp.tar tp && tar tf tp.tar", match: "tp/f" },
      { covers: "sqlite3 is present", run: "sqlite3 -batch :memory: 'select 6*7'", want: "42" },
      { covers: "qjs is present", run: "qjs -e 'console.log(1+1)'", want: "2" },
    ],
  },

  // ---- the shell ---------------------------------------------------------
  {
    // Kept after being replaced, because it is the evidence. This build takes
    // SIGINT on `$(...)` and dies, and hangs on a called function; 1.0.25 does
    // neither. Both defects are asserted below, so the difference stays
    // demonstrable rather than becoming a line in a commit message.
    name: "sharrattj/bash",
    gives: "bash 1.0.18 — the build we replaced, and why",
    isShell: true,
    checks: [
      { covers: "echo", run: "echo hello", want: "hello" },
      { covers: "arithmetic", run: "x=5; echo $((x * 3))", want: "15" },
      { covers: "for loop", run: "for i in 1 2 3; do printf '%s' $i; done", want: "123" },
      { covers: "while read", run: "printf 'a\\nb\\n' | while read l; do echo \"[$l]\"; done", want: "[a]\n[b]" },
      { covers: "if/then", run: "if [ 1 -lt 2 ]; then echo yes; else echo no; fi", want: "yes" },
      { covers: "case", run: "case abc in a*) echo matched;; *) echo no;; esac", want: "matched" },
      { covers: "pipes", run: "echo abc | cat | cat", want: "abc" },
      { covers: "redirect out", run: "echo hi > f.txt && cat f.txt", want: "hi" },
      { covers: "redirect append", run: "echo a > g.txt; echo b >> g.txt; cat g.txt", want: "a\nb" },
      { covers: "stderr redirect", run: "ls /nope 2>/dev/null; echo survived", want: "survived" },
      { covers: "here-string", run: "cat <<< 'line'", want: "line" },
      { covers: "globs", run: "touch a1.q a2.q; for f in *.q; do printf '%s ' $f; done", want: "a1.q a2.q" },
      { covers: "exit status", run: "false; echo $?", want: "1" },
      { covers: "&& and ||", run: "true && echo t; false || echo f", want: "t\nf" },
      { covers: "parameter expansion", run: "v=abcdef; echo ${v:2:3}", want: "cde" },
      { covers: "default value", run: "unset u; echo ${u:-fallback}", want: "fallback" },
      { covers: "arrays", run: "a=(x y z); echo ${a[1]} ${#a[@]}", want: "y 3" },
      { covers: "subshell", run: "(cd /tmp && pwd)", want: "/tmp" },
      { covers: "local variables", run: "v=outer; ( v=inner ); echo $v", want: "outer" },
      // Documented: a bash function defines fine and hangs when called. Kept
      // as a check so the day it stops hanging is visible, with a short
      // deadline so it costs seconds rather than a minute and a half.
      // Live defect, confirmed on code.rishwanth.dev: `x=$(echo hi)` exits 130
      // and takes the shell with it, so the next command starts in a fresh
      // shell at the folder root. Ordered last because everything after it in
      // one shell reports "the shell has exited" and would be blamed on bash.
      { covers: "cmdsub: backticks", run: "echo \"[`echo inner`]\"", want: "[inner]" },
      { covers: "cmdsub: $() bare", run: "echo $(echo inner)", want: "inner" },
      { covers: "cmdsub: $() quoted", run: "echo \"[$(echo inner)]\"", want: "[inner]" },
      { covers: "cmdsub: assignment", run: "x=$(echo hi); echo got-$x", want: "got-hi" },
      { covers: "cmdsub: no output", run: "echo a$(true)b", want: "ab" },
      { covers: "shell survives cmdsub", run: "echo alive", want: "alive" },
      // Not optional any more. These hang on 1.0.18 and work on 1.0.25, which
      // is the whole reason the pin moved — a short deadline so the old build
      // fails in seconds rather than ninety.
      { covers: "functions", run: "f() { echo fn; }; f", want: "fn", timeoutMs: 20_000 },
    ],
  },

  {
    name: "wasmer/bash",
    gives: "bash, sh",
    shipped: true,
    isShell: true,
    checks: [
      { covers: "echo", run: "echo hello", want: "hello" },
      { covers: "arithmetic", run: "x=5; echo $((x * 3))", want: "15" },
      { covers: "for loop", run: "for i in 1 2 3; do printf '%s' $i; done", want: "123" },
      { covers: "while read", run: "printf 'a\\nb\\n' | while read l; do echo \"[$l]\"; done", want: "[a]\n[b]" },
      { covers: "if/then", run: "if [ 1 -lt 2 ]; then echo yes; else echo no; fi", want: "yes" },
      { covers: "case", run: "case abc in a*) echo matched;; *) echo no;; esac", want: "matched" },
      { covers: "pipes", run: "echo abc | cat | cat", want: "abc" },
      { covers: "redirect out", run: "echo hi > f.txt && cat f.txt", want: "hi" },
      { covers: "redirect append", run: "echo a > g.txt; echo b >> g.txt; cat g.txt", want: "a\nb" },
      { covers: "stderr redirect", run: "ls /nope 2>/dev/null; echo survived", want: "survived" },
      { covers: "here-string", run: "cat <<< 'line'", want: "line" },
      { covers: "globs", run: "touch a1.q a2.q; for f in *.q; do printf '%s ' $f; done", want: "a1.q a2.q" },
      { covers: "exit status", run: "false; echo $?", want: "1" },
      { covers: "&& and ||", run: "true && echo t; false || echo f", want: "t\nf" },
      { covers: "parameter expansion", run: "v=abcdef; echo ${v:2:3}", want: "cde" },
      { covers: "default value", run: "unset u; echo ${u:-fallback}", want: "fallback" },
      { covers: "arrays", run: "a=(x y z); echo ${a[1]} ${#a[@]}", want: "y 3" },
      { covers: "subshell", run: "(cd /tmp && pwd)", want: "/tmp" },
      { covers: "local variables", run: "v=outer; ( v=inner ); echo $v", want: "outer" },
      // Documented: a bash function defines fine and hangs when called. Kept
      // as a check so the day it stops hanging is visible, with a short
      // deadline so it costs seconds rather than a minute and a half.
      // Live defect, confirmed on code.rishwanth.dev: `x=$(echo hi)` exits 130
      // and takes the shell with it, so the next command starts in a fresh
      // shell at the folder root. Ordered last because everything after it in
      // one shell reports "the shell has exited" and would be blamed on bash.
      { covers: "cmdsub: backticks", run: "echo \"[`echo inner`]\"", want: "[inner]" },
      { covers: "cmdsub: $() bare", run: "echo $(echo inner)", want: "inner" },
      { covers: "cmdsub: $() quoted", run: "echo \"[$(echo inner)]\"", want: "[inner]" },
      { covers: "cmdsub: assignment", run: "x=$(echo hi); echo got-$x", want: "got-hi" },
      { covers: "cmdsub: no output", run: "echo a$(true)b", want: "ab" },
      { covers: "shell survives cmdsub", run: "echo alive", want: "alive" },
      // Not optional any more. These hang on 1.0.18 and work on 1.0.25, which
      // is the whole reason the pin moved — a short deadline so the old build
      // fails in seconds rather than ninety.
      { covers: "functions", run: "f() { echo fn; }; f", want: "fn", timeoutMs: 20_000 },
    ],
  },

  // ---- coreutils: one check per command anyone actually types -------------
  {
    name: "sharrattj/coreutils",
    gives: "101 commands — the everyday set",
    shipped: true,
    checks: [
      { covers: "cat", run: "printf 'x\\n' > c.txt; cat c.txt", want: "x" },
      { covers: "ls", run: "mkdir -p ld && touch ld/one; ls ld", want: "one" },
      { covers: "cp", run: "echo v > s1; cp s1 d1; cat d1", want: "v" },
      { covers: "mv", run: "echo v > s2; mv s2 d2; cat d2", want: "v" },
      { covers: "rm", run: "touch r1; rm r1; ls r1 2>/dev/null; echo gone", want: "gone" },
      { covers: "mkdir -p", run: "mkdir -p deep/a/b && echo made", want: "made" },
      { covers: "rmdir", run: "mkdir -p rd && rmdir rd && echo removed", want: "removed" },
      { covers: "touch", run: "touch t1 && ls t1", want: "t1" },
      { covers: "echo", run: "echo spoken", want: "spoken" },
      { covers: "printf", run: "printf '%s-%d' ab 7", want: "ab-7" },
      { covers: "wc -l", run: "printf 'x\\ny\\n' | wc -l | tr -d ' '", want: "2" },
      { covers: "wc -c", run: "printf 'abc' | wc -c | tr -d ' '", want: "3" },
      { covers: "head", run: "printf '1\\n2\\n3\\n' | head -n 2", want: "1\n2" },
      { covers: "tail -n", run: "printf '1\\n2\\n3\\n' | tail -n 1", want: "3" },
      { covers: "tail -1 (legacy syntax)", run: "printf '1\\n2\\n3\\n' | tail -1", want: "3" },
      { covers: "sort", run: "printf 'b\\na\\nc\\n' | sort", want: "a\nb\nc" },
      { covers: "sort -n", run: "printf '10\\n2\\n' | sort -n", want: "2\n10" },
      { covers: "uniq", run: "printf 'a\\na\\nb\\n' | uniq", want: "a\nb" },
      { covers: "uniq -c", run: "printf 'a\\na\\n' | uniq -c | tr -d ' '", want: "2a" },
      { covers: "cut -c", run: "echo abcdef | cut -c2-4", want: "bcd" },
      { covers: "cut -d -f", run: "echo a:b:c | cut -d: -f2", want: "b" },
      { covers: "tr", run: "echo hello | tr a-z A-Z", want: "HELLO" },
      { covers: "tr -d", run: "echo a1b2 | tr -d 0-9", want: "ab" },
      { covers: "tr -s", run: "echo 'a   b' | tr -s ' '", want: "a b" },
      { covers: "tee", run: "echo t | tee tee.txt >/dev/null; cat tee.txt", want: "t" },
      { covers: "seq", run: "seq 3", want: "1\n2\n3" },
      { covers: "basename", run: "basename /a/b/c.txt", want: "c.txt" },
      { covers: "dirname", run: "dirname /a/b/c.txt", want: "/a/b" },
      { covers: "test", run: "test -f seed.txt && echo present", want: "present" },
      { covers: "env", run: "FOO=bar env | grep '^FOO=' ", want: "FOO=bar" },
      { covers: "pwd", run: "pwd", want: "/workspace" },
      { covers: "nl", run: "printf 'x\\n' | nl | tr -s ' \\t' ' ' | sed 's/^ //'", want: "1 x" },
      { covers: "paste", run: "printf 'a\\n' > p1; printf 'b\\n' > p2; paste p1 p2", want: "a\tb" },
      { covers: "comm", run: "printf 'a\\n' > c1; printf 'a\\n' > c2; comm -12 c1 c2", want: "a" },
      { covers: "split", run: "printf 'a\\nb\\n' > sp.txt; split -l 1 sp.txt part_; cat part_aa", want: "a" },
      { covers: "od", run: "printf 'A' | od -An -c | tr -d ' \\n'", want: "A" },
      { covers: "base64", run: "printf 'hi' | base64", want: "aGk=" },
      { covers: "base64 -d", run: "printf 'aGk=' | base64 -d", want: "hi" },
      { covers: "sha256sum", run: "printf '' | sha256sum | cut -c1-8", want: "e3b0c442" },
      { covers: "md5sum", run: "printf '' | md5sum | cut -c1-8", want: "d41d8cd9" },
      { covers: "readlink -f", run: "readlink -f seed.txt", match: "seed\\.txt$" },
      { covers: "ln -s", run: "ln -s seed.txt link.txt && cat link.txt", want: "seeded" },
      { covers: "stat", run: "stat seed.txt >/dev/null && echo statted", want: "statted" },
      { covers: "du", run: "du -s seed.txt >/dev/null && echo sized", want: "sized" },
      { covers: "df", run: "df >/dev/null && echo reported", want: "reported" },
      { covers: "date", run: "date +%Y", match: "^20[0-9][0-9]$" },
      { covers: "true / false", run: "true && false; echo $?", want: "1" },
      { covers: "yes + head", run: "yes ok | head -n 2", want: "ok\nok" },
      { covers: "expand", run: "printf 'a\\tb\\n' | expand -t 1", want: "a b" },
      { covers: "fold", run: "echo abcdef | fold -w 3", want: "abc\ndef" },
      { covers: "factor", run: "factor 12", want: "12: 2 2 3" },
      { covers: "sleep", run: "sleep 0.1 && echo slept", want: "slept" },
    ],
  },

  {
    // The same move that fixed bash: a different build of the same tool. The
    // shipped one is uutils 0.0.7 as a multi-call binary, where `sort` prints
    // its usage instead of sorting.
    name: "wasmer/coreutils",
    gives: "coreutils 1.0.25 — a newer build than the 1.0.16 we ship",
    checks: [
      { covers: "cat", run: "printf 'x\\n' > c.txt; cat c.txt", want: "x" },
      { covers: "ls", run: "mkdir -p ld && touch ld/one; ls ld", want: "one" },
      { covers: "cp", run: "echo v > s1; cp s1 d1; cat d1", want: "v" },
      { covers: "mv", run: "echo v > s2; mv s2 d2; cat d2", want: "v" },
      { covers: "rm", run: "touch r1; rm r1; ls r1 2>/dev/null; echo gone", want: "gone" },
      { covers: "mkdir -p", run: "mkdir -p deep/a/b && echo made", want: "made" },
      { covers: "rmdir", run: "mkdir -p rd && rmdir rd && echo removed", want: "removed" },
      { covers: "touch", run: "touch t1 && ls t1", want: "t1" },
      { covers: "echo", run: "echo spoken", want: "spoken" },
      { covers: "printf", run: "printf '%s-%d' ab 7", want: "ab-7" },
      { covers: "wc -l", run: "printf 'x\\ny\\n' | wc -l | tr -d ' '", want: "2" },
      { covers: "wc -c", run: "printf 'abc' | wc -c | tr -d ' '", want: "3" },
      { covers: "head", run: "printf '1\\n2\\n3\\n' | head -n 2", want: "1\n2" },
      { covers: "tail -n", run: "printf '1\\n2\\n3\\n' | tail -n 1", want: "3" },
      { covers: "tail -1 (legacy syntax)", run: "printf '1\\n2\\n3\\n' | tail -1", want: "3" },
      { covers: "sort", run: "printf 'b\\na\\nc\\n' | sort", want: "a\nb\nc" },
      { covers: "sort -n", run: "printf '10\\n2\\n' | sort -n", want: "2\n10" },
      { covers: "uniq", run: "printf 'a\\na\\nb\\n' | uniq", want: "a\nb" },
      { covers: "uniq -c", run: "printf 'a\\na\\n' | uniq -c | tr -d ' '", want: "2a" },
      { covers: "cut -c", run: "echo abcdef | cut -c2-4", want: "bcd" },
      { covers: "cut -d -f", run: "echo a:b:c | cut -d: -f2", want: "b" },
      { covers: "tr", run: "echo hello | tr a-z A-Z", want: "HELLO" },
      { covers: "tr -d", run: "echo a1b2 | tr -d 0-9", want: "ab" },
      { covers: "tr -s", run: "echo 'a   b' | tr -s ' '", want: "a b" },
      { covers: "tee", run: "echo t | tee tee.txt >/dev/null; cat tee.txt", want: "t" },
      { covers: "seq", run: "seq 3", want: "1\n2\n3" },
      { covers: "basename", run: "basename /a/b/c.txt", want: "c.txt" },
      { covers: "dirname", run: "dirname /a/b/c.txt", want: "/a/b" },
      { covers: "test", run: "test -f seed.txt && echo present", want: "present" },
      { covers: "env", run: "FOO=bar env | grep '^FOO=' ", want: "FOO=bar" },
      { covers: "pwd", run: "pwd", want: "/workspace" },
      { covers: "nl", run: "printf 'x\\n' | nl | tr -s ' \\t' ' ' | sed 's/^ //'", want: "1 x" },
      { covers: "paste", run: "printf 'a\\n' > p1; printf 'b\\n' > p2; paste p1 p2", want: "a\tb" },
      { covers: "comm", run: "printf 'a\\n' > c1; printf 'a\\n' > c2; comm -12 c1 c2", want: "a" },
      { covers: "split", run: "printf 'a\\nb\\n' > sp.txt; split -l 1 sp.txt part_; cat part_aa", want: "a" },
      { covers: "od", run: "printf 'A' | od -An -c | tr -d ' \\n'", want: "A" },
      { covers: "base64", run: "printf 'hi' | base64", want: "aGk=" },
      { covers: "base64 -d", run: "printf 'aGk=' | base64 -d", want: "hi" },
      { covers: "sha256sum", run: "printf '' | sha256sum | cut -c1-8", want: "e3b0c442" },
      { covers: "md5sum", run: "printf '' | md5sum | cut -c1-8", want: "d41d8cd9" },
      { covers: "readlink -f", run: "readlink -f seed.txt", match: "seed\\.txt$" },
      { covers: "ln -s", run: "ln -s seed.txt link.txt && cat link.txt", want: "seeded" },
      { covers: "stat", run: "stat seed.txt >/dev/null && echo statted", want: "statted" },
      { covers: "du", run: "du -s seed.txt >/dev/null && echo sized", want: "sized" },
      { covers: "df", run: "df >/dev/null && echo reported", want: "reported" },
      { covers: "date", run: "date +%Y", match: "^20[0-9][0-9]$" },
      { covers: "true / false", run: "true && false; echo $?", want: "1" },
      { covers: "yes + head", run: "yes ok | head -n 2", want: "ok\nok" },
      { covers: "expand", run: "printf 'a\\tb\\n' | expand -t 1", want: "a b" },
      { covers: "fold", run: "echo abcdef | fold -w 3", want: "abc\ndef" },
      { covers: "factor", run: "factor 12", want: "12: 2 2 3" },
      { covers: "sleep", run: "sleep 0.1 && echo slept", want: "slept" },
    ],
  },

  // ---- text tools --------------------------------------------------------
  {
    name: "wasmer/grep",
    gives: "grep",
    shipped: true,
    checks: [
      { covers: "basic match", run: "printf 'alpha\\nbeta\\n' | grep beta", want: "beta" },
      { covers: "-i insensitive", run: "printf 'Foo\\n' | grep -i foo", want: "Foo" },
      { covers: "-v invert", run: "printf 'x\\ny\\n' | grep -v x", want: "y" },
      { covers: "-c count", run: "printf 'a1\\nb2\\n' | grep -c '[0-9]'", want: "2" },
      { covers: "-n line numbers", run: "printf 'a\\nb\\n' | grep -n b", want: "2:b" },
      { covers: "-o only match", run: "echo 'xAy' | grep -o A", want: "A" },
      { covers: "-w word", run: "printf 'cat\\ncatalog\\n' | grep -w cat", want: "cat" },
      { covers: "-E extended", run: "printf 'ab\\n' | grep -E 'a|z'", want: "ab" },
      { covers: "-F fixed", run: "printf 'a.b\\n' | grep -F 'a.b'", want: "a.b" },
      { covers: "-q quiet", run: "printf 'x\\n' | grep -q x && echo found", want: "found" },
      { covers: "-r recursive", run: "mkdir -p gr && echo needle > gr/f.txt; grep -r needle gr", want: "gr/f.txt:needle" },
      { covers: "-l files only", run: "mkdir -p gl && echo hay > gl/f.txt; grep -l hay gl/f.txt", want: "gl/f.txt" },
      { covers: "-A after context", run: "printf 'a\\nb\\n' | grep -A1 a", want: "a\nb" },
      { covers: "exit 1 on no match", run: "printf 'a\\n' | grep zzz; echo $?", want: "1" },
    ],
  },
  {
    name: "wasmer/sed",
    gives: "sed",
    shipped: true,
    checks: [
      { covers: "substitute", run: "echo abc | sed 's/b/X/'", want: "aXc" },
      { covers: "global substitute", run: "echo aaa | sed 's/a/b/g'", want: "bbb" },
      { covers: "-n with p", run: "printf 'a\\nb\\nc\\n' | sed -n '2p'", want: "b" },
      { covers: "delete", run: "printf 'a\\nb\\n' | sed '/a/d'", want: "b" },
      { covers: "line range", run: "printf '1\\n2\\n3\\n' | sed -n '1,2p'", want: "1\n2" },
      { covers: "-e multiple", run: "echo ab | sed -e 's/a/1/' -e 's/b/2/'", want: "12" },
      { covers: "& whole match", run: "echo abc | sed 's/b/[&]/'", want: "a[b]c" },
      { covers: "backreference", run: "echo ab | sed -E 's/(a)(b)/\\2\\1/'", want: "ba" },
      { covers: "-i in place", run: "echo old > i.txt; sed -i 's/old/new/' i.txt; cat i.txt", want: "new" },
      { covers: "append after", run: "printf 'a\\n' | sed '/a/a added'", want: "a\nadded" },
      { covers: "$ last line", run: "printf '1\\n2\\n' | sed -n '$p'", want: "2" },
    ],
  },
  {
    name: "wasmer/find",
    gives: "find",
    shipped: true,
    checks: [
      { covers: "-name", run: "mkdir -p fa && touch fa/a.txt fa/b.log; find fa -name '*.txt'", want: "fa/a.txt" },
      { covers: "-type f", run: "mkdir -p fb/sub && touch fb/file; find fb -type f", want: "fb/file" },
      { covers: "-type d", run: "mkdir -p fc/sub; find fc -type d -name sub", want: "fc/sub" },
      { covers: "-maxdepth", run: "mkdir -p fd/x/y && touch fd/top fd/x/y/deep; find fd -maxdepth 1 -type f", want: "fd/top" },
      { covers: "-path", run: "mkdir -p fe/keep && touch fe/keep/f; find fe -path '*keep*' -type f", want: "fe/keep/f" },
      { covers: "-exec", run: "mkdir -p ff && echo body > ff/one.txt; find ff -name '*.txt' -exec cat {} \\;", want: "body" },
      // `-size -1k` matching a 3-byte file is what the first version of this
      // expected, and GNU does not do that either: sizes round up to whole
      // blocks, so a 3-byte file is 1k and `-1k` means "rounds to zero".
      { covers: "-size in bytes", run: "mkdir -p fg && printf 'abc' > fg/small; find fg -type f -size +0c", want: "fg/small" },
      { covers: "-size rounds up like GNU", run: "mkdir -p fh2 && printf 'abc' > fh2/s; find fh2 -type f -size -1k; echo none", want: "none" },
      { covers: "-empty", run: "mkdir -p fh && touch fh/blank; find fh -type f -empty", want: "fh/blank" },
    ],
  },

  // ---- cheap additions that passed ---------------------------------------
  {
    name: "syrusakbary/jq",
    gives: "jq",
    shipped: true,
    checks: [
      { covers: "field access", run: "echo '{\"a\":1}' | jq -r .a", want: "1" },
      { covers: "nested field", run: "echo '{\"x\":{\"y\":\"z\"}}' | jq -r .x.y", want: "z" },
      { covers: "array iteration", run: "echo '[{\"n\":1},{\"n\":2}]' | jq -r '.[].n' | tr '\\n' ' '", want: "1 2" },
      { covers: "arithmetic", run: "echo '[1,2,3]' | jq 'add'", want: "6" },
      { covers: "length", run: "echo '[1,2,3]' | jq 'length'", want: "3" },
      { covers: "keys", run: "echo '{\"b\":1,\"a\":2}' | jq -rc 'keys'", want: '["a","b"]' },
      { covers: "select filter", run: "echo '[1,2,3]' | jq -c '[.[] | select(. > 1)]'", want: "[2,3]" },
      { covers: "map", run: "echo '[1,2]' | jq -c 'map(. * 2)'", want: "[2,4]" },
      { covers: "-c compact", run: "echo '{\"a\":1}' | jq -c .", want: '{"a":1}' },
      { covers: "string interpolation", run: "echo '{\"n\":\"x\"}' | jq -r '\"v=\\(.n)\"'", want: "v=x" },
      { covers: "reads a file", run: "echo '{\"k\":9}' > j.json; jq -r .k j.json", want: "9" },
    ],
  },
  {
    name: "wasmer/tar",
    gives: "tar",
    shipped: true,
    checks: [
      { covers: "create", run: "mkdir -p ta && echo one > ta/f.txt && tar cf a.tar ta && echo made", want: "made" },
      { covers: "list", run: "mkdir -p tb && echo x > tb/g.txt && tar cf b.tar tb && tar tf b.tar", match: "g\\.txt" },
      { covers: "extract", run: "mkdir -p tc && echo two > tc/h.txt && tar cf c.tar tc && rm -rf tc && tar xf c.tar && cat tc/h.txt", want: "two" },
      // `-C` extracts correctly and then exits 2, the same way `find` exits 1
      // after doing its work — neither can restore its working directory under
      // WASIX. Chaining with && hid a successful extraction behind the status,
      // so this reads the file rather than trusting the exit code.
      { covers: "-C directory", run: "mkdir -p td out && echo z > td/i.txt && tar cf d.tar td; tar xf d.tar -C out; cat out/td/i.txt", want: "z" },
      { covers: "round trip preserves content", run: "mkdir -p te && printf 'line1\\nline2\\n' > te/j.txt && tar cf e.tar te && rm -rf te && tar xf e.tar && wc -l < te/j.txt | tr -d ' '", want: "2" },
    ],
  },
  {
    name: "wasmer/gzip",
    gives: "gzip, gunzip",
    shipped: true,
    checks: [
      { covers: "compress", run: "echo compressme > z.txt && gzip z.txt && ls z.txt.gz", want: "z.txt.gz" },
      { covers: "decompress", run: "echo roundtrip > r.txt && gzip r.txt && gunzip r.txt.gz && cat r.txt", want: "roundtrip" },
      { covers: "-c to stdout", run: "echo s > s.txt && gzip -c s.txt > s.gz && gunzip -c s.gz", want: "s" },
      { covers: "-d decompress flag", run: "echo d > d.txt && gzip d.txt && gzip -d d.txt.gz && cat d.txt", want: "d" },
      { covers: "content survives", run: "printf 'a\\nb\\nc\\n' > m.txt && gzip m.txt && gunzip m.txt.gz && wc -l < m.txt | tr -d ' '", want: "3" },
    ],
  },
  {
    name: "sqlite/sqlite",
    gives: "sqlite3",
    shipped: true,
    checks: [
      { covers: "expression", run: "sqlite3 :memory: 'select 1+1'", want: "2" },
      { covers: "create and select", run: "sqlite3 t.db 'create table x(a);insert into x values(7);select a from x'", want: "7" },
      { covers: "persists to disk", run: "sqlite3 p.db 'create table y(v)'; sqlite3 p.db \"insert into y values('kept')\"; sqlite3 p.db 'select v from y'", want: "kept" },
      { covers: "aggregate", run: "sqlite3 :memory: 'select sum(v) from (select 1 v union all select 2)'", want: "3" },
      { covers: "join", run: "sqlite3 :memory: 'create table a(i);create table b(i);insert into a values(1);insert into b values(1);select count(*) from a join b using(i)'", want: "1" },
      { covers: "order by", run: "sqlite3 :memory: \"select v from (select 'b' v union select 'a') order by v\"", want: "a\nb" },
      { covers: ".mode csv", run: "sqlite3 -csv :memory: \"select 'a','b'\"", want: "a,b" },
      { covers: "reads a sql file", run: "echo 'select 42;' > q.sql; sqlite3 -batch :memory: < q.sql", want: "42" },
    ],
  },
  {
    name: "saghul/quickjs",
    gives: "qjs — JavaScript without node's 74 MB",
    shipped: true,
    checks: [
      { covers: "eval", run: "qjs -e 'console.log(1+1)'", want: "2" },
      { covers: "JSON", run: "qjs -e 'console.log(JSON.stringify({a:1}))'", want: '{"a":1}' },
      { covers: "array methods", run: "qjs -e 'console.log([3,1,2].sort().join(\",\"))'", want: "1,2,3" },
      { covers: "string methods", run: "qjs -e 'console.log(\"ab\".toUpperCase())'", want: "AB" },
      { covers: "closures", run: "qjs -e 'const f=x=>y=>x+y; console.log(f(1)(2))'", want: "3" },
      { covers: "Math", run: "qjs -e 'console.log(Math.max(1,9,3))'", want: "9" },
      { covers: "runs a file", run: "echo 'console.log(\"from file\")' > s.js; qjs s.js", want: "from file" },
      { covers: "template literals", run: "qjs -e 'const n=2;console.log(`n=${n}`)'", want: "n=2" },
    ],
  },

  // ---- language runtimes -------------------------------------------------
  {
    name: "python/python",
    gives: "python3, pip",
    shipped: true,
    heavy: true,
    checks: [
      { covers: "expression", run: "python3 -c 'print(1+1)'", want: "2" },
      { covers: "json", run: "python3 -c \"import json;print(json.dumps({'a':1}))\"", want: '{"a": 1}' },
      { covers: "csv", run: "printf 'a,b\\n1,2\\n' > d.csv && python3 -c \"import csv;print(list(csv.reader(open('d.csv')))[1][1])\"", want: "2" },
      { covers: "re", run: "python3 -c \"import re;print(re.sub(r'a+','X','aaab'))\"", want: "Xb" },
      { covers: "os and pathlib", run: "python3 -c \"import os;print(os.path.basename('/a/b.txt'))\"", want: "b.txt" },
      { covers: "file write", run: "python3 -c \"open('pw.txt','w').write('written')\"; python3 -c \"print(open('pw.txt').read())\"", want: "written" },
      { covers: "file written is visible to the shell", run: "python3 -c \"open('pv.txt','w').write('seen')\"; cat pv.txt", want: "seen" },
      { covers: "python and the shell agree on cwd", run: "python3 -c \"import os;print(os.getcwd())\"; pwd", want: "/workspace\n/workspace" },
      { covers: "exceptions (via a script file)", run: "printf 'try:\\n  1/0\\nexcept ZeroDivisionError:\\n  print(\\\"caught\\\")\\n' > ex.py && python3 ex.py", want: "caught" },
      { covers: "exit status", run: "python3 -c 'raise SystemExit(3)'; echo $?", want: "3" },
      { covers: "argv", run: "python3 -c 'import sys;print(sys.argv[1])' hello", want: "hello" },
      { covers: "math", run: "python3 -c 'import math;print(int(math.sqrt(16)))'", want: "4" },
      { covers: "collections", run: "python3 -c \"from collections import Counter;print(Counter('aab')['a'])\"", want: "2" },
      { covers: "datetime", run: "python3 -c \"import datetime;print(datetime.date(2020,1,2).isoformat())\"", want: "2020-01-02" },
      { covers: "runs a script file", run: "echo \"print('scripted')\" > s.py && python3 s.py", want: "scripted" },
      { covers: "stdin", run: "echo piped | python3 -c \"import sys;print(sys.stdin.read().strip())\"", want: "piped" },
      { covers: "version is 3", run: "python3 -c 'import sys;print(sys.version_info[0])'", want: "3" },
    ],
  },
  {
    name: "wasmer/edgejs",
    gives: "node, npm, pnpm",
    heavy: true,
    checks: [
      { covers: "eval", run: "node -e 'console.log(1+1)'", want: "2" },
      { covers: "JSON", run: "node -e 'console.log(JSON.stringify({a:1}))'", want: '{"a":1}' },
      { covers: "fs write and read", run: "node -e \"require('fs').writeFileSync('n.txt','nodewrote')\" && cat n.txt", want: "nodewrote" },
      { covers: "path module", run: "node -e \"console.log(require('path').basename('/a/b.js'))\"", want: "b.js" },
      { covers: "process.argv with -e", run: "node -e 'console.log(process.argv[1])' hi", want: "hi" },
      { covers: "process.argv with a file", run: "echo 'console.log(process.argv[2])' > a.js && node a.js hi", want: "hi" },
      { covers: "exit status", run: "node -e 'process.exit(4)'; echo $?", want: "4" },
      { covers: "runs a file", run: "echo 'console.log(\"filed\")' > n.js && node n.js", want: "filed" },
      { covers: "npm version", run: "npm --version", match: "^[0-9]+\\." },
      { covers: "async/await", run: "node -e '(async()=>{console.log(await Promise.resolve(7))})()'", want: "7" },
    ],
  },
  {
    name: "php/php",
    gives: "php",
    heavy: true,
    checks: [
      { covers: "echo", run: "php -r 'echo 1+1;'", want: "2" },
      { covers: "arrays", run: "php -r 'echo count([1,2,3]);'", want: "3" },
      { covers: "json", run: "php -r 'echo json_encode([\"a\"=>1]);'", want: '{"a":1}' },
      { covers: "string functions", run: "php -r 'echo strtoupper(\"ab\");'", want: "AB" },
      { covers: "file write", run: "php -r 'file_put_contents(\"ph.txt\",\"phpwrote\");' && cat ph.txt", want: "phpwrote" },
      { covers: "runs a file", run: "printf '<?php echo \"scripted\";' > s.php && php s.php", want: "scripted" },
    ],
  },
  {
    name: "syrusakbary/clang",
    gives: "clang — a C compiler",
    heavy: true,
    checks: [
      { covers: "version", run: "clang --version | head -1", match: "clang" },
      { covers: "compiles and runs", run: "printf '#include <stdio.h>\\nint main(){puts(\"hi\");return 0;}' > m.c && clang m.c -o m 2>/dev/null && ./m", want: "hi" },
      { covers: "arithmetic program", run: "printf '#include <stdio.h>\\nint main(){printf(\"%%d\",6*7);return 0;}' > n.c && clang n.c -o n 2>/dev/null && ./n", want: "42" },
      { covers: "exit status passes through", run: "printf 'int main(){return 3;}' > e.c && clang e.c -o e 2>/dev/null && ./e; echo $?", want: "3" },
    ],
  },

  // ---- found by enumerating the registry rather than guessing names -------
  //
  // An earlier search probed 420 name guesses across six namespaces and
  // concluded these did not exist. Enumerating every package that ships a
  // command — 550 of them — found all of these. Guessing is not searching.
  {
    // Listed by the API with full metadata, and `packages.load` cannot fetch
    // it — the same as every kilyanni package. Two namespaces now behave this
    // way, so registry presence remains no guide to installability.
    name: "liftm/rg",
    gives: "ripgrep — listed by the API, not installable",
    checks: [
      { covers: "basic match", run: "mkdir -p rg1 && printf 'alpha\\nbeta\\n' > rg1/f.txt; rg beta rg1/f.txt", want: "beta" },
      { covers: "recursive by default", run: "mkdir -p rg2/sub && echo needle > rg2/sub/deep.txt; rg needle rg2", match: "needle" },
      { covers: "-i insensitive", run: "mkdir -p rg3 && echo Foo > rg3/f; rg -i foo rg3/f", want: "Foo" },
      { covers: "-c count", run: "mkdir -p rg4 && printf 'a1\\nb2\\n' > rg4/f; rg -c '[0-9]' rg4/f", want: "2" },
      { covers: "-n line numbers", run: "mkdir -p rg5 && printf 'a\\nb\\n' > rg5/f; rg -n b rg5/f", want: "2:b" },
      { covers: "-l files with matches", run: "mkdir -p rg6 && echo hay > rg6/f.txt; rg -l hay rg6", match: "f\\.txt" },
      { covers: "-w word boundary", run: "mkdir -p rg7 && printf 'cat\\ncatalog\\n' > rg7/f; rg -w cat rg7/f", want: "cat" },
      { covers: "reads stdin", run: "printf 'x\\ny\\n' | rg y", want: "y" },
      { covers: "exit 1 on no match", run: "printf 'a\\n' | rg zzz; echo $?", want: "1" },
    ],
  },
  {
    name: "liftm/fd",
    gives: "fd — listed by the API, not installable",
    checks: [
      { covers: "finds by name", run: "mkdir -p fd1 && touch fd1/target.txt; fd target fd1", match: "target\\.txt" },
      { covers: "-e extension", run: "mkdir -p fd2 && touch fd2/a.txt fd2/b.log; fd -e txt . fd2", match: "a\\.txt" },
      { covers: "-t f files only", run: "mkdir -p fd3/sub && touch fd3/file; fd -t f . fd3", match: "file" },
      { covers: "exit 1 on no match", run: "mkdir -p fd4 && touch fd4/x; fd nothingmatches fd4; echo $?", want: "1" },
    ],
  },
  {
    // `cal` works; `rev` and `hexdump` exit 1. Half a megabyte for a calendar
    // is not a trade worth making.
    name: "syrusakbary/util-linux",
    gives: "cal works, rev and hexdump do not",
    checks: [
      { covers: "rev", run: "echo abc | rev", want: "cba" },
      { covers: "hexdump -C", run: "printf 'A' | hexdump -C", match: "41" },
      { covers: "cal", run: "cal 1 2020", match: "January 2020" },
    ],
  },
  {
    // Installs and then exits 11 on every invocation.
    name: "jackbm633/bzip2",
    gives: "bzip2 — installs, does not run",
    checks: [
      { covers: "compress", run: "echo squeeze > bz.txt && bzip2 bz.txt && ls bz.txt.bz2", want: "bz.txt.bz2" },
      { covers: "round trip", run: "echo keepme > bz2.txt && bzip2 bz2.txt && bzip2 -d bz2.txt.bz2 && cat bz2.txt", want: "keepme" },
    ],
  },
  {
    // Probed without CPython, because the question is whether it can replace
    // it — 22.3 MB against 58.9 would take the mirror from 80 MB to 43. Next
    // to CPython it would pass on CPython's working directory and prove
    // nothing, which is the same trap that made a reduced sandbox look like a
    // broken package earlier.
    // Not a replacement, despite 22.3 MB against CPython's 58.9. Installed
    // without CPython, `pwd` still says /workspace but every relative path
    // fails and `open()` raises PermissionError — the exact signature of a
    // sandbox missing CPython. The filesystem comes from the CPython package,
    // not from the runtime, and rustpython does not bring one.
    //
    // It passes everything when installed alongside CPython, where it is
    // redundant. That is why `without` exists: next to the thing it would
    // replace, a replacement proves nothing.
    name: "rustpython/rustpython",
    gives: "a second python — cannot replace CPython, see below",
    without: ["python/python"],
    checks: [
      { covers: "provides a working directory", run: "pwd", want: "/workspace" },
      { covers: "relative paths resolve", run: "echo hi > rel.txt; cat rel.txt", want: "hi" },
      { covers: "seeded file readable", run: "cat seed.txt", want: "seeded" },
      { covers: "re", run: "rustpython -c \"import re;print(re.sub(r'a+','X','aaab'))\"", want: "Xb" },
      { covers: "csv", run: "printf 'a,b\\n1,2\\n' > d2.csv && rustpython -c \"import csv;print(list(csv.reader(open('d2.csv')))[1][1])\"", want: "2" },
      { covers: "datetime", run: "rustpython -c \"import datetime;print(datetime.date(2020,1,2).isoformat())\"", want: "2020-01-02" },
      { covers: "collections", run: "rustpython -c \"from collections import Counter;print(Counter('aab')['a'])\"", want: "2" },
      { covers: "expression", run: "rustpython -c 'print(1+1)'", want: "2" },
      { covers: "json", run: "rustpython -c \"import json;print(json.dumps({'a':1}))\"", want: '{"a": 1}' },
      { covers: "file io", run: "rustpython -c \"open('rp.txt','w').write('rp')\"; cat rp.txt", want: "rp" },
      { covers: "runs a script", run: "echo \"print('scripted')\" > rp.py && rustpython rp.py", want: "scripted" },
    ],
  },
  {
    // `ruby -e` works; a script file exits 1. The most-downloaded real tool
    // in the registry, and it cannot run a .rb file.
    name: "katei/ruby",
    gives: "ruby — -e works, script files do not",
    heavy: true,
    checks: [
      { covers: "expression", run: "ruby -e 'puts 1+1'", want: "2" },
      { covers: "string methods", run: "ruby -e 'puts \"ab\".upcase'", want: "AB" },
      { covers: "runs a script", run: "echo 'puts 9' > r.rb && ruby r.rb", want: "9" },
    ],
  },

  // ---- present in the registry API, but not installable ------------------
  //
  // Every kilyanni package resolves through GraphQL with full metadata and
  // then fails `packages.load` with "not found". Kept so the day that changes
  // is one probe run away — their coreutils is GNU 9.11 at half the size of
  // what we ship, which would be worth having.
  { name: "kilyanni/coreutils", gives: "GNU coreutils 9.11, 2.4 MB", checks: [
      { covers: "sort reads stdin", run: "printf 'b\\na\\n' | sort", want: "a\nb" } ] },
  { name: "kilyanni/find", gives: "find, and xargs — which we lack entirely", checks: [
      { covers: "xargs", run: "printf '1\\n2\\n' | xargs -n1 echo n", want: "n 1\nn 2" } ] },
  { name: "kilyanni/curl", gives: "curl — cannot reach anything from a browser", checks: [
      { covers: "version", run: "curl --version | head -1", match: "^curl" } ] },

  // ---- probed and found wanting ------------------------------------------
  {
    name: "kilyanni/git",
    gives: "git — local only, no clone or push",
    heavy: true,
    checks: [
      { covers: "version", run: "git --version", match: "^git version" },
      { covers: "init", run: "mkdir -p r && cd r && git init -q . && echo ok", want: "ok" },
      // `git log` alone exits 79 with no output: git launches a pager when
      // stdout is a terminal, and there is no pager here to launch. Every
      // paging command needs --no-pager or GIT_PAGER=cat. Worth knowing before
      // shipping git, because the failure looks like a lost commit.
      { covers: "commit then log (needs --no-pager)", run: "mkdir -p s && cd s && git init -q . && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m x && git --no-pager log --oneline | wc -l | tr -d ' '", want: "1" },
      { covers: "log without --no-pager still fails", run: "mkdir -p s2 && cd s2 && git init -q .; git -c user.email=a@b -c user.name=n commit -q --allow-empty -m x; git log >/dev/null 2>&1; echo rc=$?", want: "rc=79" },
      { covers: "add and status", run: "mkdir -p t2 && cd t2 && git init -q . && echo f > f.txt && git add f.txt && git status --porcelain", match: "A\\s+f\\.txt" },
    ],
  },
  {
    // Does not start at all: even `lua -v` exits 45 with no output, and this
    // is the only lua published. Kept so the day a working build appears is
    // one run away.
    name: "syrusakbary/lua",
    gives: "lua — the only published build, and it does not run",
    checks: [
      { covers: "eval", run: "lua -e 'print(1+1)'", want: "2" },
      { covers: "string methods", run: "lua -e 'print((\"x\"):rep(3))'", want: "xxx" },
    ],
  },
];
