# things-mcp

![GitHub release](https://img.shields.io/github/v/release/charlesbeaumont/things-mcp)
![License](https://img.shields.io/github/license/charlesbeaumont/things-mcp)
![Platform](https://img.shields.io/badge/platform-macOS-blue)

A Things 3 MCP server compiled to a single Bun binary.

## What it does

- 17 tools covering reads, bulk-by-default writes (`add_todos`, `update_todos`), structured project creation with headings, and a single multi-filter `search`.
- Reads via direct SQLite (read-only) against the Things app database.
- Writes via the Things URL scheme (`things:///json`), single URL call per batch.
- Behaviour matches the Things UI: Someday-project filtering, `groupTodayByParent`, effective list label (Today / Upcoming derived from `start` + `startDate`).

SQL queries are ported from [things.py](https://github.com/thingsapi/things.py) (MIT).

## Install

**Quick path (no Bun needed):** download `things-mcp-vX.Y.Z-darwin-arm64` from the [Releases page](https://github.com/charlesbeaumont/things-mcp/releases/latest), then:

```bash
chmod +x things-mcp-*-darwin-arm64
xattr -d com.apple.quarantine things-mcp-*-darwin-arm64
mv things-mcp-*-darwin-arm64 /usr/local/bin/things-mcp   # or anywhere on $PATH
```

**Build from source:** make sure [Bun](https://bun.sh) is installed (`brew install oven-sh/bun/bun`), then:

```bash
git clone https://github.com/charlesbeaumont/things-mcp.git
cd things-mcp
./install.sh
```

`install.sh` builds the binary, strips the macOS quarantine flag, and prints the JSON snippet to add to your MCP client config.

You also need to enable the Things URL scheme once: **Things → Settings → General → "Enable Things URLs"**. Without it, all writes silently no-op.

For Claude Desktop, paste the snippet from `install.sh` into `~/Library/Application Support/Claude/claude_desktop_config.json` under `mcpServers`, then restart Claude Desktop.

## Writes are array-shaped

```jsonc
// add_todos — works for 1 or N
{
  "todos": [
    { "title": "Buy milk", "when": "today" },
    { "title": "Call Anne", "when": "tomorrow", "tags": ["Calls"] },
    { "title": "Review Q3 plan", "list_title": "🧠 Full Focus" }
  ]
}

// update_todos — same shape
{
  "updates": [
    { "id": "abc123", "completed": true },
    { "id": "def456", "when": "next monday", "tags": ["Important"] }
  ]
}

// add_project — items mixes headings and todos
{
  "title": "Q3 prep",
  "items": [
    { "type": "heading", "title": "Plan",  "items": [{ "title": "Outline" }, { "title": "Review" }] },
    { "type": "heading", "title": "Build", "items": [{ "title": "Implement" }] }
  ]
}
```

All writes compile to a single `things:///json?data=[...]` URL call. Auto-chunks if the encoded URL exceeds ~200 KB (~50+ items, depending on payload).

## Layout

```
src/
  index.ts            MCP server entrypoint
  things-db.ts        bun:sqlite reader, SQL queries
  things-url.ts       URL builder + executor + /json bulk
  formatters.ts       Markdown formatters for tasks/projects/areas/tags/headings
  someday-filter.ts   Someday-project filter
  tools.ts            All 17 tool definitions
  types.ts            Task/Area/Tag types
```

## Dev

```bash
bun src/index.ts        # run from source (no build)
npx tsc --noEmit        # typecheck
```
