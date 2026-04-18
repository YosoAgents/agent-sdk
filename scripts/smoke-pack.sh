#!/usr/bin/env bash
# Smoke test: build + pack the SDK, install into a temp workspace, run a setup
# against the target backend, assert the response shape doesn't leak a private
# key. Used before tagging a release and in release-candidate CI.
#
# Usage:
#   scripts/smoke-pack.sh <YOSO_API_URL> <YOSO_CANONICAL_AUDIENCE>
#
# Example (staging):
#   scripts/smoke-pack.sh https://yosobet-app-staging.up.railway.app yoso.bet-staging
#
# Exits 0 on success, non-zero on any failure with an explanatory message.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <YOSO_API_URL> <YOSO_CANONICAL_AUDIENCE>" >&2
  exit 2
fi

API_URL="$1"
AUDIENCE="$2"

SDK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SDK_ROOT"

echo "==> building"
npm run build >/dev/null

echo "==> packing"
TARBALL="$(npm pack 2>/dev/null | tail -n1)"
if [ ! -f "$SDK_ROOT/$TARBALL" ]; then
  echo "ERROR: npm pack did not produce a tarball" >&2
  exit 1
fi
echo "    tarball: $TARBALL"

TMPDIR="$(mktemp -d -t yoso-smoke-XXXXXX)"
trap 'rm -rf "$TMPDIR" "$SDK_ROOT/$TARBALL"' EXIT
echo "==> temp workspace: $TMPDIR"

cd "$TMPDIR"
npm init -y >/dev/null
npm install "$SDK_ROOT/$TARBALL" >/dev/null 2>&1

AGENT_NAME="smoke-$(date +%s)"

echo "==> running setup against $API_URL (audience=$AUDIENCE, agent=$AGENT_NAME)"
YOSO_API_URL="$API_URL" YOSO_CANONICAL_AUDIENCE="$AUDIENCE" \
  npx yoso-agent setup --name "$AGENT_NAME" --yes --skip-fund-poll 2>&1 | tee setup.log

if ! [ -f "$TMPDIR/.env" ]; then
  echo "FAIL: .env not written to temp workspace" >&2
  exit 1
fi
if ! grep -q '^AGENT_PRIVATE_KEY=0x[0-9a-fA-F]\{64\}$' "$TMPDIR/.env"; then
  echo "FAIL: AGENT_PRIVATE_KEY missing or malformed in .env" >&2
  exit 1
fi
if ! [ -f "$TMPDIR/config.json" ]; then
  echo "FAIL: config.json not written" >&2
  exit 1
fi
if ! grep -q '"apiKey":' "$TMPDIR/config.json"; then
  echo "FAIL: apiKey not present in config.json" >&2
  exit 1
fi
if grep -q 'walletPrivateKey' setup.log; then
  echo "FAIL: setup output mentioned walletPrivateKey — server is leaking secrets" >&2
  exit 1
fi

echo ""
echo "==> PASS"
echo "    Agent created: $AGENT_NAME"
echo "    Private key lives in temp workspace (.env) — will be wiped on exit"
