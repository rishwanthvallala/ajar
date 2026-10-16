/**
 * What the lab asks every model: a cursor in the middle of real-looking code,
 * and what a person would type to finish the line there. Mostly Python, as
 * the pad is mostly used for it, then JavaScript, Java and C.
 *
 * Judged on the line only: an editor shows one line of ghost text, and a
 * model that writes the right line and then three more is still right.
 */
export interface Case {
  lang: string;
  name: string;
  prefix: string;
  expected: string;
  suffix: string;
}

const FLASK = `from flask import Flask, render_template, request

`;

export const CASES: Case[] = [
  { lang: "python", name: "import alias", prefix: "import numpy as ", expected: "np", suffix: "\n\nvalues = np.zeros(10)\n" },
  { lang: "python", name: "Flask app", prefix: `${FLASK}app = `, expected: "Flask(__name__)", suffix: "\n\n\n@app.route(\"/\")\ndef index():\n    return render_template(\"index.html\")\n" },
  { lang: "python", name: "a second route", prefix: `${FLASK}app = Flask(__name__)\n\n\n@app.route("/")\ndef index():\n    return render_template("index.html")\n\n\n@app.route("/about")\ndef about():\n    return render_template(`, expected: "\"about.html\")", suffix: "\n" },
  { lang: "python", name: "for over a list", prefix: "names = [\"ada\", \"bob\", \"cy\"]\nfor name in ", expected: "names:", suffix: "\n    print(name)\n" },
  { lang: "python", name: "return a sum", prefix: "def add(a, b):\n    return ", expected: "a + b", suffix: "\n\n\nprint(add(2, 3))\n" },
  { lang: "python", name: "read lines", prefix: "with open(\"data.txt\") as f:\n    lines = f.", expected: "readlines()", suffix: "\n\nfor line in lines:\n    print(line.strip())\n" },
  { lang: "python", name: "main guard", prefix: "def main():\n    print(\"hello\")\n\n\nif __name__ == ", expected: "\"__main__\":", suffix: "\n    main()\n" },
  { lang: "python", name: "comprehension", prefix: "numbers = [1, 2, 3, 4]\nsquares = [n * n for n in ", expected: "numbers]", suffix: "\nprint(squares)\n" },
  { lang: "python", name: "json.load", prefix: "import json\n\nwith open(\"config.json\") as f:\n    config = json.", expected: "load(f)", suffix: "\n\nprint(config[\"name\"])\n" },
  { lang: "python", name: "constructor", prefix: "class Point:\n    def __init__(self, x, y):\n        self.x = x\n        self.y = ", expected: "y", suffix: "\n\n    def __repr__(self):\n        return f\"Point({self.x}, {self.y})\"\n" },
  { lang: "python", name: "except", prefix: "text = input(\"A number: \")\ntry:\n    value = int(text)\nexcept ", expected: "ValueError:", suffix: "\n    value = 0\n" },
  { lang: "python", name: "f-string", prefix: "name = input(\"Your name: \")\nprint(f\"Hello, {", expected: "name}!\")", suffix: "\n" },
  { lang: "python", name: "response.json", prefix: "import requests\n\nresponse = requests.get(\"https://api.example.com/items\")\nitems = response.", expected: "json()", suffix: "\nprint(len(items))\n" },
  { lang: "python", name: "recursion", prefix: "def factorial(n):\n    if n == 0:\n        return 1\n    return n * ", expected: "factorial(n - 1)", suffix: "\n" },
  { lang: "python", name: "form field", prefix: `${FLASK}app = Flask(__name__)\n\n\n@app.route("/login", methods=["POST"])\ndef login():\n    name = request.form[`, expected: "\"name\"]", suffix: "\n    return f\"Hello, {name}\"\n" },
  { lang: "python", name: "dict get", prefix: "counts = {}\nfor word in text.split():\n    counts[word] = counts.get(", expected: "word, 0) + 1", suffix: "\n" },
  { lang: "javascript", name: "map", prefix: "const items = [1, 2, 3];\nconst doubled = items.map((x) => ", expected: "x * 2);", suffix: "\nconsole.log(doubled);\n" },
  { lang: "javascript", name: "fetch json", prefix: "fetch(\"/api/items\")\n  .then((response) => response.", expected: "json())", suffix: "\n  .then((items) => console.log(items));\n" },
  { lang: "javascript", name: "return a string", prefix: "function greet(name) {\n  return ", expected: "\"Hello, \" + name;", suffix: "\n}\n\nconsole.log(greet(\"ada\"));\n" },
  { lang: "javascript", name: "for loop", prefix: "const items = [\"a\", \"b\", \"c\"];\nfor (let i = 0; i < ", expected: "items.length; i++) {", suffix: "\n  console.log(items[i]);\n}\n" },
  { lang: "javascript", name: "require", prefix: "const express = require(", expected: "\"express\");", suffix: "\nconst app = express();\n\napp.listen(3000);\n" },
  { lang: "java", name: "println", prefix: "public class Main {\n    public static void main(String[] args) {\n        System.out.", expected: "println(\"Hello, world\");", suffix: "\n    }\n}\n" },
  { lang: "java", name: "new list", prefix: "import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        List<String> names = new ", expected: "ArrayList<>();", suffix: "\n        names.add(\"ada\");\n    }\n}\n" },
  { lang: "c", name: "include", prefix: "#include <", expected: "stdio.h>", suffix: "\n\nint main(void) {\n    printf(\"hi\\n\");\n    return 0;\n}\n" },
];

/** The first line of what a model wrote, as an editor would show it. */
export function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.replace(/\s+$/, "");
}

/**
 * CodeT5's spacing, tidied. It writes `load ( f)`, `"name" ]` and
 * `names :` — trained, it seems, on code stored as tokens joined by spaces
 * (CodeSearchNet's) — and a space before a closing bracket or a colon, or
 * inside an opening one, is nearly never what anyone typed. One after a
 * keyword stays: `if (`, `for (`, `return (`.
 */
export function tidy(text: string): string {
  return text
    .replace(/\s+([)\]};,:.])/g, "$1")
    .replace(/([([{.])\s+/g, "$1")
    .replace(/\b(?!(?:if|for|while|switch|catch|return|in|and|or|not|elif|with|except)\b)(\w+)\s+\(/g, "$1(");
}

/** How much of the expected line a suggestion gets right, from its start: 1 for all of it. */
export function score(suggestion: string, expected: string): { exact: boolean; share: number } {
  const got = suggestion.trim();
  const want = expected.trim();
  if (!got) return { exact: false, share: 0 };
  let same = 0;
  while (same < got.length && same < want.length && got[same] === want[same]) same++;
  // A suggestion that goes on past a wrong character is wrong from there: only
  // what matches from the start would be kept by someone pressing Tab.
  return { exact: got === want, share: same / want.length };
}
