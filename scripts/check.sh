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

echo "── tsc ───────────────────────────────────────────────"
(cd web && npx tsc --noEmit)

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

echo "── smoke: reconnect ──────────────────────────────────"
node scripts/smoke-reconnect.mjs

echo "── acceptance ────────────────────────────────────────"
node scripts/acceptance.mjs

echo
echo "all green"
