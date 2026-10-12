#!/usr/bin/env bash
# sign-binary.sh [binary] — give the binary a stable code identity.
# macOS keys the "access data from other apps" approval to the binary's
# designated requirement. Bun's ad-hoc signature makes that a per-build hash,
# so every rebuild asks again. A certificate signature keeps it stable.
# Without the certificate this falls back to ad-hoc, which still runs anywhere.
set -euo pipefail

cd "$(dirname "$0")"
BIN="${1:-bin/things-mcp}"
ID="com.charlesbeaumont.things-mcp"
IDENTITY="${THINGS_MCP_SIGN_IDENTITY:-things-mcp local}"

if security find-identity -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
  codesign --force --sign "$IDENTITY" --identifier "$ID" "$BIN"
else
  echo "note: no \"$IDENTITY\" code-signing certificate found; signing ad-hoc." >&2
  echo "      macOS will ask for Things data access again after each rebuild." >&2
  codesign --force --sign - --identifier "$ID" "$BIN"
fi
codesign --verify "$BIN"
