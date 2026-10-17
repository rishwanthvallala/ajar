"""Restore one lockfile-pinned Windows optional binding skipped by WSL's older Node."""
from pathlib import Path
import base64
import hashlib
import io
import json
import tarfile
import urllib.request

root = Path(__file__).resolve().parents[2]
relative = "node_modules/@rolldown/binding-win32-x64-msvc"
entry = json.loads((root / "package-lock.json").read_text(encoding="utf8"))["packages"][relative]
data = urllib.request.urlopen(entry["resolved"], timeout=60).read()
assert "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode() == entry["integrity"]
dest = (root / relative).resolve()
assert dest.is_relative_to(root)
with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
    for item in archive:
        assert item.name.startswith("package/")
        target = (dest / item.name[len("package/"):]).resolve()
        assert target.is_relative_to(dest)
        if item.isdir():
            target.mkdir(parents=True, exist_ok=True)
        elif item.isfile():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(item).read())
        else:
            raise ValueError("unexpected archive member")
print(f"Restored {relative}@{entry['version']} from lockfile; sha512 verified; {len(data)} tarball bytes")
