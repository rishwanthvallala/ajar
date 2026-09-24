#!/usr/bin/env bash
# Everything that has to be green before a commit.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

echo "── cargo fmt ─────────────────────────────────────────"
cargo fmt --check

echo "── cargo clippy ──────────────────────────────────────"
cargo clippy --all-targets -- -D warnings

echo "── cargo test ────────────────────────────────────────"
cargo test --quiet

echo "── frontend typecheck ─────────────────────────────────"
npm run typecheck

echo "── frontend builds ────────────────────────────────────"
npm run build

# Deleting a workspace and forgetting the Dockerfile is a build that only
# breaks at release time. This is the cheap half of `docker build`.
echo "── dockerfile: every COPY source exists ──────────────"
missing=$(awk '/^COPY / && $2 !~ /^--from=/ { for (i = 2; i < NF; i++) print $i }' Dockerfile \
  | while read -r src; do [ -e "$src" ] || echo "  $src"; done)
if [ -n "$missing" ]; then
  echo "Dockerfile copies paths that do not exist:" >&2
  echo "$missing" >&2
  exit 1
fi

# Skipping is deliberate and opt-in, never something a missing dependency
# decides. Whatever is skipped is named in the summary, so "all green" keeps
# meaning every check ran.
skipped=""
if [ "${AJAR_SKIP_UI:-}" = "1" ]; then
  echo "── ui: layout and boot ─── skipped (AJAR_SKIP_UI=1) ──"
  skipped="the UI suite"
else
  echo "── ui: layout and boot ───────────────────────────────"
  node scripts/test-ui.cjs
fi

echo "── build for the smoke tests ─────────────────────────"
cargo build --quiet

echo "── smoke: the spine ──────────────────────────────────"
node scripts/smoke.mjs

echo "── smoke: workspace ──────────────────────────────────"
node scripts/smoke-workspace.mjs

echo "── smoke: editing ────────────────────────────────────"
node scripts/smoke-editing.mjs

echo "── smoke: sync ───────────────────────────────────────"
node scripts/smoke-sync.mjs

echo "── smoke: encryption ─────────────────────────────────"
node scripts/smoke-encryption.mjs

echo "── smoke: host controls ──────────────────────────────"
node scripts/smoke-control.mjs

echo "── smoke: what a guest's shell inherits ──────────────"
node scripts/smoke-environment.mjs

echo "── smoke: reconnect ──────────────────────────────────"
node scripts/smoke-reconnect.mjs

echo "── smoke: peer sessions ──────────────────────────────"
node scripts/smoke-peer.mjs

echo "── smoke: abuse ──────────────────────────────────────"
node scripts/smoke-abuse.mjs

echo "── acceptance ────────────────────────────────────────"
node scripts/acceptance.mjs

echo
if [ -n "$skipped" ]; then
  echo "all green except $skipped — skipped on purpose, so this is not a full gate"
else
  echo "all green"
fi
