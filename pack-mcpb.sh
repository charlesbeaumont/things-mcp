#!/usr/bin/env bash
# pack-mcpb.sh [version] — stage manifest.json, icon.png and bin/things-mcp, then pack a .mcpb.
# Version defaults to package.json's. CI passes the tag with the leading "v" stripped.
# Expects bin/things-mcp to exist already (bun run build).
set -euo pipefail

cd "$(dirname "$0")"
VERSION="${1:-$(bun -e 'console.log(require("./package.json").version)')}"
MCPB="npx -y @anthropic-ai/mcpb@2.1.2"
STAGE="dist/mcpb"
OUT="dist/things-mcp-v$VERSION.mcpb"

if [ ! -x bin/things-mcp ]; then
  echo "error: bin/things-mcp missing. Run: bun run build" >&2
  exit 1
fi

rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE/bin"
cp icon.png "$STAGE/"
cp bin/things-mcp "$STAGE/bin/things-mcp"
chmod 755 "$STAGE/bin/things-mcp"
VERSION="$VERSION" bun -e '
  const m = await Bun.file("manifest.json").json();
  m.version = process.env.VERSION;
  await Bun.write(process.argv[1], JSON.stringify(m, null, 2) + "\n");
' "$STAGE/manifest.json"

$MCPB validate "$STAGE/manifest.json"
$MCPB pack "$STAGE" "$OUT"
echo "✓ Packed: $OUT"
