/**
 * requirements.txt, as the pad keeps installed packages: `.deps`, where pip
 * puts them, is not saved with a pad (sync.ts), so the file is what carries
 * them to whoever opens it next. A typed `pip install` adds to it, and Run
 * installs from it first (App.recordInstalled, App.installRequirements).
 */

/** The requirements a requirements.txt names: its lines, without comments, blanks or pip options. */
export function requirementLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("-"));
}

/** A requirement's package name as pip compares them: `Pandas>=2` and `pandas` are one. */
export function requirementName(spec: string): string {
  return spec.split(/[<>=!~;\[\s@]/)[0]!.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Options of `pip install` that take a value as the next word. */
const PIP_VALUED = new Set(["-t", "--target", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "--prefix", "--root", "--platform", "--python-version", "--implementation", "--abi", "--only-binary", "--no-binary", "--upgrade-strategy", "--src", "--log", "--cache-dir", "--progress-bar", "--trusted-host", "--proxy", "--timeout", "--retries"]);

/**
 * The packages a typed line installs with pip, as requirement lines — or
 * null when it is not a plain `pip install`: one from a file (`-r`), an
 * editable path, a URL or a wheel names nothing requirements.txt should hold.
 */
export function pipInstalled(line: string): string[] | null {
  // A pipeline, a redirect, a substitution: not a plain install. Inside
  // quotes they are a version — 'flask>=3' — and fine.
  if (/[|;&`$()<>]/.test(line.replace(/'[^']*'|"[^"]*"/g, ""))) return null;
  const words = line.trim().split(/\s+/);
  let i = 0;
  if (/^python3?$/.test(words[i] ?? "") && words[i + 1] === "-m") i += 2;
  if (!/^pip3?$/.test(words[i] ?? "") || words[i + 1] !== "install") return null;
  const specs: string[] = [];
  for (let j = i + 2; j < words.length; j++) {
    const word = words[j]!.replace(/^(['"])(.*)\1$/, "$2");
    if (["-r", "--requirement", "-e", "--editable", "-c", "--constraint"].includes(word)) return null;
    if (PIP_VALUED.has(word)) {
      j++;
      continue;
    }
    if (word.startsWith("-")) continue;
    if (/[/\\:]|^\.|\.(whl|zip|tar\.gz)$/.test(word)) return null;
    specs.push(word);
  }
  return specs.length ? specs : null;
}
