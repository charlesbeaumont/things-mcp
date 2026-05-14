# things-mcp

A Things 3 MCP server compiled to a single Bun binary.

## What it does

- 24 tools: full read parity with [hald/things-mcp](https://github.com/hald/things-mcp) plus first-class bulk editing (`bulk_add_todos`, `bulk_update_todos`).
- Reads via direct SQLite (read-only) against the Things app database.
- Writes via the Things URL scheme (`things:///add`, `things:///update`, `things:///json`).
- Someday-project filter matches Things UI: tasks inside Someday projects are hidden from Today/Upcoming/Anytime.

SQL queries are ported from [things.py](https://github.com/thingsapi/things.py) (MIT).

## Install

Make sure [Bun](https://bun.sh) is installed (`brew install oven-sh/bun/bun`), then:

```bash
git clone https://github.com/charlesbeaumont/things-mcp.git
cd things-mcp
./install.sh
```

`install.sh` builds the binary, strips the macOS quarantine flag, and prints the JSON snippet to add to your MCP client config.

You also need to enable the Things URL scheme once: **Things → Settings → General → "Enable Things URLs"**. Without it, all writes silently no-op.

For Claude Desktop, paste the snippet from `install.sh` into `~/Library/Application Support/Claude/claude_desktop_config.json` under `mcpServers`, then restart Claude Desktop.

## Bulk editing

```jsonc
// bulk_add_todos
{
  "todos": [
    { "title": "Buy milk", "when": "today" },
    { "title": "Call Anne", "when": "tomorrow", "tags": ["Calls"] },
    { "title": "Review Q3 plan", "list": "🧠 Full Focus" }
  ]
}

// bulk_update_todos
{
  "updates": [
    { "id": "abc123", "completed": true },
    { "id": "def456", "when": "next monday", "tags": ["Important"] }
  ]
}
```

Both compile to a single `things:///json?data=[...]` URL call. Auto-chunks if the encoded URL exceeds ~200 KB (~50+ items, depending on payload).

## Layout

```
src/
  index.ts            MCP server entrypoint
  things-db.ts        bun:sqlite reader, SQL queries
  things-url.ts       URL builder + executor + /json bulk
  formatters.ts       Markdown output (matches hald shape)
  someday-filter.ts   Someday-project filter
  tools.ts            All 24 tool definitions
  types.ts            Task/Area/Tag types
```

## Dev

```bash
bun src/index.ts        # run from source (no build)
npx tsc --noEmit        # typecheck
```
