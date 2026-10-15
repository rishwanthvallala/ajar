/**
 * What an empty file can start as: a few lines that run and print, in the
 * shape a program of that kind has, as an online compiler opens with.
 *
 * Offered, never put there: an empty file shows a line saying it can have one
 * (App.paintStarter), and taking it is an ordinary edit — everyone on the pad
 * sees it, and undo takes it back. Each prints the same two things, so one
 * that runs can be told from one that does not.
 *
 * Written with a tab for each level of indent, and given the indent set for
 * the editor (format.ts); Go's stays a tab, as gofmt has it. C++ uses
 * <cstdio>, because <iostream> does not finish compiling here (toolchains.ts).
 */

export interface Starter {
  /** What it is called in the offer: "a Java starter". */
  label: string;
  text: string;
  /** Where the caret goes after it: the line, 1-based. */
  line: number;
}

const JAVA_KEYWORDS = new Set(
  ("abstract assert boolean break byte case catch char class const continue default do double else enum extends " +
    "final finally float for goto if implements import instanceof int interface long native new package private " +
    "protected public return short static strictfp super switch synchronized this throw throws transient try void " +
    "volatile while true false null var record yield sealed permits _").split(" "),
);

/** A class `java File.java` and `javac File.java` both take: named for the file when the name can be one. */
function javaClass(stem: string): { name: string; public: boolean } {
  const ok = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(stem) && !JAVA_KEYWORDS.has(stem);
  return ok ? { name: stem, public: true } : { name: "Main", public: false };
}

const C = `#include <stdio.h>

int main(void) {
\tconst char *name = "world";
\tprintf("Hello, %s!\\n", name);
\tfor (int i = 1; i <= 3; i++) {
\t\tprintf("%d squared is %d\\n", i, i * i);
\t}
\treturn 0;
}
`;

const CPP = `// <cstdio>, not <iostream>: <iostream> does not finish compiling here.
#include <cstdio>

template <typename T>
T square(T n) {
\treturn n * n;
}

int main() {
\tstd::printf("Hello, %s!\\n", "world");
\tfor (int i = 1; i <= 3; i++) {
\t\tstd::printf("%d squared is %d\\n", i, square(i));
\t}
\treturn 0;
}
`;

const JS = `const name = "world";
console.log(\`Hello, \${name}!\`);
for (let i = 1; i <= 3; i++) {
\tconsole.log(\`\${i} squared is \${i * i}\`);
}
`;

const TS = `function square(n: number): number {
\treturn n * n;
}

const name: string = "world";
console.log(\`Hello, \${name}!\`);
for (let i = 1; i <= 3; i++) {
\tconsole.log(\`\${i} squared is \${square(i)}\`);
}
`;

const SH = `#!/bin/sh
name="world"
echo "Hello, $name!"
for i in 1 2 3; do
\techo "$i squared is $((i * i))"
done
`;

/** By extension, lower case; each a function of the file's name without its extension. */
const STARTERS: Record<string, (stem: string) => { label: string; text: string; line: number }> = {
  py: () => ({
    label: "a Python starter",
    text: `def main():
\tname = "world"
\tprint(f"Hello, {name}!")
\tfor i in range(1, 4):
\t\tprint(f"{i} squared is {i * i}")


if __name__ == "__main__":
\tmain()
`,
    line: 5,
  }),
  java: (stem) => {
    const cls = javaClass(stem);
    return {
      label: "a Java starter",
      text: `${cls.public ? "public " : ""}class ${cls.name} {
\tpublic static void main(String[] args) {
\t\tString name = "world";
\t\tSystem.out.println("Hello, " + name + "!");
\t\tfor (int i = 1; i <= 3; i++) {
\t\t\tSystem.out.println(i + " squared is " + i * i);
\t\t}
\t}
}
`,
      line: 6,
    };
  },
  c: () => ({ label: "a C starter", text: C, line: 7 }),
  cpp: () => ({ label: "a C++ starter", text: CPP, line: 12 }),
  cc: () => ({ label: "a C++ starter", text: CPP, line: 12 }),
  cxx: () => ({ label: "a C++ starter", text: CPP, line: 12 }),
  go: () => ({
    label: "a Go starter",
    text: `package main

import "fmt"

func main() {
\tname := "world"
\tfmt.Printf("Hello, %s!\\n", name)
\tfor i := 1; i <= 3; i++ {
\t\tfmt.Printf("%d squared is %d\\n", i, i*i)
\t}
}
`,
    line: 9,
  }),
  js: () => ({ label: "a JavaScript starter", text: JS, line: 4 }),
  mjs: () => ({ label: "a JavaScript starter", text: JS, line: 4 }),
  cjs: () => ({ label: "a JavaScript starter", text: JS, line: 4 }),
  ts: () => ({ label: "a TypeScript starter", text: TS, line: 8 }),
  php: () => ({
    label: "a PHP starter",
    text: `<?php

$name = "world";
echo "Hello, $name!\\n";
for ($i = 1; $i <= 3; $i++) {
\techo "$i squared is " . $i * $i . "\\n";
}
`,
    line: 6,
  }),
  sh: () => ({ label: "a shell starter", text: SH, line: 5 }),
  bash: () => ({ label: "a shell starter", text: SH, line: 5 }),
  html: () => ({
    label: "an HTML page",
    text: `<!doctype html>
<html lang="en">
<head>
\t<meta charset="utf-8">
\t<meta name="viewport" content="width=device-width, initial-scale=1">
\t<title>Hello</title>
\t<style>
\t\tbody { font-family: system-ui, sans-serif; margin: 2rem; }
\t</style>
</head>
<body>
\t<h1>Hello, world!</h1>
\t<p id="out"></p>
\t<script>
\t\tdocument.getElementById("out").textContent = "1 squared is 1, 2 squared is 4, 3 squared is 9";
\t</script>
</body>
</html>
`,
    line: 12,
  }),
  css: () => ({
    label: "a stylesheet",
    text: `:root {
\t--ink: #1f2328;
\t--accent: #0969da;
}

body {
\tmargin: 2rem;
\tfont-family: system-ui, sans-serif;
\tcolor: var(--ink);
}

a {
\tcolor: var(--accent);
}
`,
    line: 8,
  }),
  json: () => ({
    label: "a JSON object",
    text: `{
\t"name": "example",
\t"version": 1,
\t"tags": ["pad", "starter"],
\t"enabled": true
}
`,
    line: 2,
  }),
  sql: () => ({
    label: "a SQL starter",
    text: `CREATE TABLE people (
\tid INTEGER PRIMARY KEY,
\tname TEXT NOT NULL
);

INSERT INTO people (name) VALUES ('Ada'), ('Grace');

SELECT id, name FROM people ORDER BY name;
`,
    line: 8,
  }),
  md: () => ({
    label: "a Markdown outline",
    text: `# Title

A line or two about what this is.

## Notes

- One
- Two

\`\`\`python
print("Hello, world!")
\`\`\`
`,
    line: 3,
  }),
  yaml: () => ({
    label: "a YAML starter",
    text: `name: example
version: 1
tags:
\t- pad
\t- starter
settings:
\tenabled: true
`,
    line: 1,
  }),
  toml: () => ({
    label: "a TOML starter",
    text: `[package]
name = "example"
version = "0.1.0"

[settings]
enabled = true
`,
    line: 2,
  }),
};
STARTERS.yml = STARTERS.yaml!;
STARTERS.htm = STARTERS.html!;

/** What `path` can start as, its indent `unit` for each level — or null when there is nothing to offer. */
export function starterFor(path: string, unit: string): Starter | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  const make = STARTERS[ext];
  if (!make) return null;
  const starter = make(name.slice(0, dot));
  // Go is indented with tabs whatever the editor's indent is: gofmt's way.
  if (ext === "go") return starter;
  return { ...starter, text: starter.text.replace(/^\t+/gm, (tabs) => unit.repeat(tabs.length)) };
}
