#!/usr/bin/env bash
# install.sh — build the things-mcp binary and print the Claude Desktop config snippet.
# Does NOT modify ~/Library/Application Support/Claude/claude_desktop_config.json
# automatically; that's a manual step so we don't clobber other MCP entries.
set -euo pipefail

cd "$(dirname "$0")"
BIN="$PWD/bin/things-mcp"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun not found in PATH. Install with: brew install oven-sh/bun/bun" >&2
  exit 1
fi

echo "→ Installing dependencies"
bun install --silent

echo "→ Typechecking"
bun run typecheck >/dev/null

echo "→ Building binary"
bun run build

echo "→ Removing macOS quarantine flag (no-op if not quarantined)"
xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true

cat <<EOF

✓ Built: $BIN
  $(file -b "$BIN")
  $(du -h "$BIN" | cut -f1)

Add this to ~/Library/Application Support/Claude/claude_desktop_config.json
under "mcpServers", then restart Claude Desktop:

    "things": {
      "command": "$BIN"
    }

If Things 3 isn't yet configured to accept URL scheme writes:
  Things → Settings → General → "Enable Things URLs"
EOF
