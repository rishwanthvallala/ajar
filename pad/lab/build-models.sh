#!/usr/bin/env bash
# The completion lab's CodeT5-small builds, made in a container so that torch
# and the ONNX exporter never touch this machine. Writes them where the lab
# page loads them from: pad/public/vendor/lab/models/ (gitignored, like the
# rest of public/vendor/). See convert.py for what each build is.
#
#   pad/lab/build-models.sh            # podman, or ENGINE=docker
set -euo pipefail
cd "$(dirname "$0")"
ENGINE=${ENGINE:-podman}
OUT="$(cd .. && pwd)/public/vendor/lab/models"
mkdir -p "$OUT"
IMAGE=python:3.12-slim
"$ENGINE" run --rm \
  -v "$PWD/convert.py:/convert.py:ro" \
  -v "$OUT:/out" \
  "$IMAGE" bash -euo pipefail -c '
    pip install --quiet --no-cache-dir --root-user-action=ignore torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu
    pip install --quiet --no-cache-dir --root-user-action=ignore \
      transformers==4.46.3 optimum==1.23.3 onnx==1.17.0 onnxruntime==1.22.1 sentencepiece==0.2.0
    mkdir -p /work && python /convert.py
  '
