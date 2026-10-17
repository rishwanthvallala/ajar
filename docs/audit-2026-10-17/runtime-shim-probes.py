"""Bounded differential checks of shipped Python shims against Git's GNU tools."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
cases = [
    ("awk addition of numeric fields", "awk", ["{print $1 + $2}"], "3 4\n"),
    ("awk multiplication of numeric field", "awk", ["{print $1 * 2}"], "3\n"),
    ("awk regular-expression field separator", "awk", ["-F", "[,:]", "{print $2}"], "a,b:c\n"),
    ("sort key without explicit end extends to line end", "sort", ["-k2"], "a same z\nb same a\n"),
    ("sort nonnumber under numeric sort equals zero", "sort", ["-n"], "-1\nword\n2\n"),
    ("sort arbitrary precision numeric integers", "sort", ["-n"], "9007199254740993\n9007199254740992\n"),
    ("sort last-resort whole-line comparison", "sort", ["-k2,2"], "z same\na same\n"),
]

results = []
for title, tool, args, data in cases:
    shim = subprocess.run([sys.executable, str(ROOT / "pad/src/tools" / f"{tool}.py"), *args], input=data, capture_output=True, text=True)
    native = subprocess.run([str(Path("D:/Git/usr/bin") / f"{tool}.exe"), *args], input=data, capture_output=True, text=True, env={"LC_ALL": "C", **__import__("os").environ})
    results.append({"case": title, "argv": args, "input": data, "shim": {"exit": shim.returncode, "stdout": shim.stdout, "stderr": shim.stderr}, "GNU": {"exit": native.returncode, "stdout": native.stdout, "stderr": native.stderr}, "same": (shim.returncode, shim.stdout) == (native.returncode, native.stdout)})

with tempfile.TemporaryDirectory(prefix="pad-audit-shim-") as tmp:
    a, b = Path(tmp) / "a", Path(tmp) / "b"
    a.write_text("z", encoding="utf8")
    b.write_text("a\n", encoding="utf8")
    args = [str(a), str(b)]
    shim = subprocess.run([sys.executable, str(ROOT / "pad/src/tools/sort.py"), *args], capture_output=True, text=True)
    native = subprocess.run(["D:/Git/usr/bin/sort.exe", *args], capture_output=True, text=True)
    results.append({"case": "sort multiple input files without final newline", "shim": {"exit": shim.returncode, "stdout": shim.stdout}, "GNU": {"exit": native.returncode, "stdout": native.stdout}, "same": (shim.returncode, shim.stdout) == (native.returncode, native.stdout)})

print(json.dumps(results, ensure_ascii=False, indent=2))
