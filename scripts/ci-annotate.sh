#!/usr/bin/env bash
# Run a command in CI; if it fails, the end of its output becomes an annotation.
#
#   scripts/ci-annotate.sh "<title>" <command> [args...]
#
# A job's log can only be read signed in, and its annotations can be read by
# anyone through the API and on the run's page — which is the difference
# between a macOS-only failure being diagnosable from a terminal or not. An
# annotation keeps about its first 4 KB, so this is the *end* of the output:
# colour codes and the build's size tables out, the last 3.5 KB of what is left.
set -o pipefail
title=$1
shift
"$@" 2>&1 | tee ci.log || {
  status=$?
  sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' ci.log \
    | grep -v -E '^dist/|│ gzip|chunks are larger|dynamic import|manualChunks|chunkSizeWarningLimit|codeSplitting|^\s*$' \
    | tail -c 3500 | sed 's/%/%25/g' \
    | awk 'BEGIN { ORS = "%0A" } { gsub(/\r/, "%0D"); print }' > ci-tail.txt
  echo "::error title=${title}::$(cat ci-tail.txt)"
  exit "$status"
}
