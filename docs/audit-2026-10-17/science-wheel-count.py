"""Inspect one advertised WASIX wheel without installing or executing it."""
from pathlib import Path
import hashlib
import io
import json
import re
import urllib.parse
import urllib.request
import zipfile

base = 'https://python-registry.wasmer.app/simple/numpy/'
html = urllib.request.urlopen(base, timeout=30).read().decode()
href = next(href for href in re.findall(r'href="([^"]+\.whl#[^"]+)"', html) if 'cp313-cp313-wasix_wasm32' in href)
url, fragment = urllib.parse.urldefrag(urllib.parse.urljoin(base, href))
data = urllib.request.urlopen(url, timeout=60).read()
sha = urllib.parse.parse_qs(fragment)['sha256'][0]
assert hashlib.sha256(data).hexdigest() == sha
with zipfile.ZipFile(io.BytesIO(data)) as wheel:
    files = [item for item in wheel.infolist() if not item.is_dir()]
    kept = [item for item in files if not item.filename.endswith('.pyc') and '/__pycache__/' not in item.filename]
    print(json.dumps({'url': url, 'sha256Verified': sha, 'compressedBytes': len(data), 'archiveFiles': len(files), 'nonPycFiles': len(kept), 'uncompressedBytes': sum(item.file_size for item in kept), 'padMaxFilesIncludingDependencies': 500}, indent=2))
