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

/**
 * The line as the install alone, when it succeeding is what a line's exit 0
 * says — or null.
 *
 * Its output sent to a file is fine: `pip install numpy > log.txt 2>&1` is
 * what the guide says to type to keep clear of a pipeline that hangs, and
 * until 18 October it was refused for its `>`, so that advice left the
 * package out of requirements.txt (review N2). So is a command after `&&`,
 * which runs only if pip's succeeded. A pipe, `;`, `||` or a substitution is
 * not: the line's status is then somebody else's. Inside quotes these are a
 * version — 'flask>=3' — and fine.
 */
function plainInstall(line: string): string | null {
  const quoted: string[] = [];
  const masked = line.replace(/'[^']*'|"[^"]*"/g, (q) => `\u0000${quoted.push(q) - 1}\u0000`);
  const install = masked
    .split("&&")[0]!
    .replace(/(^|\s)(?:\d|&)?>>?(?:&\d|\s*[^\s|;&<>()`$\u0000]+)/g, "$1");
  if (/[|;&`$()<>]/.test(install)) return null;
  return install.replace(/\u0000(\d+)\u0000/g, (_, i: string) => quoted[Number(i)]!);
}

/** Options of `pip install` that take a value as the next word. */
const PIP_VALUED = new Set(["-t", "--target", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "--prefix", "--root", "--platform", "--python-version", "--implementation", "--abi", "--only-binary", "--no-binary", "--upgrade-strategy", "--src", "--log", "--cache-dir", "--progress-bar", "--trusted-host", "--proxy", "--timeout", "--retries"]);

/**
 * The packages a typed line installs with pip, as requirement lines — or
 * null when it is not a plain `pip install`: one from a file (`-r`), an
 * editable path, a URL or a wheel names nothing requirements.txt should hold.
 */
export function pipInstalled(line: string): string[] | null {
  const plain = plainInstall(line);
  if (plain === null) return null;
  const words = plain.trim().split(/\s+/);
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
