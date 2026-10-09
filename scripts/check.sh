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

echo "── smoke: the host's blip ────────────────────────────"
node scripts/smoke-hostdrop.mjs

if [ "${AJAR_SKIP_UI:-}" = "1" ]; then
  echo "── ui: a host's blip, in the browser ─── skipped (AJAR_SKIP_UI=1) ──"
else
  echo "── ui: a host's blip, in the browser ─────────────────"
  node scripts/check-host-drop.mjs
fi

if [ "${AJAR_SKIP_UI:-}" = "1" ]; then
  echo "── ui: a guest's page through what goes wrong ─── skipped (AJAR_SKIP_UI=1) ──"
else
  echo "── ui: a guest's page through what goes wrong ────────"
  node scripts/check-guest.mjs
fi

if [ "${AJAR_SKIP_UI:-}" = "1" ]; then
  echo "── ui: a guest's terminal, key by key ─── skipped (AJAR_SKIP_UI=1) ──"
else
  echo "── ui: a guest's terminal, key by key ────────────────"
  node scripts/check-terminal.mjs
fi

# The pad's own checks lived only in `npm run check` under pad/, which nothing
# ran, and an error Run never showed went unnoticed for two weeks. These two
# are the ones a person would notice. Without a mirror here the packages come
# from Wasmer's CDN, which the service worker falls back to on its own.
if [ "${AJAR_SKIP_UI:-}" = "1" ]; then
  echo "── ui: the pad, as a person uses it ─── skipped (AJAR_SKIP_UI=1) ──"
else
  echo "── ui: the pad, as a person uses it ──────────────────"
  # check.ts, in a real browser: what has to be true underneath — among it,
  # documents bound to real editors — and nothing ran it but `npm run check`.
  node pad/scripts/browser-check.mjs
  node pad/scripts/terminal-check.mjs
  node pad/scripts/user-check.mjs
  echo "── ui: accounts — owner, editor and viewer ───────────"
  node pad/scripts/accounts-check.mjs
  echo "── ui: two places in one pad ─────────────────────────"
  node pad/scripts/pair-check.mjs
fi

echo "── smoke: peer sessions ──────────────────────────────"
node scripts/smoke-peer.mjs

echo "── smoke: accounts — sign-in, and roles in the store and the room"
node scripts/smoke-accounts.mjs

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
