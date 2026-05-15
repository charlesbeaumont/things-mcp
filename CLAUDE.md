# CLAUDE.md

Guidance for Claude when working in this repo.

## What this is

A personal Things 3 MCP server. Single Bun-compiled binary that reads Things via SQLite and writes via Things' URL scheme. Bulk-by-default writes via the `/json` endpoint, plus structured project creation with headings.

Single compiled binary (Bun): one path, one Claude permission approval, no `uv`/`npx`/`node` wrapper.

## Architecture

```
src/index.ts          MCP Server (stdio transport) — wires the SDK to tool handlers
src/tools.ts          All 17 tool definitions (JSON Schema + handler)
src/things-db.ts      bun:sqlite reader. SQL ported from things.py (MIT).
src/things-url.ts     Things URL scheme builder + executor
src/formatters.ts     Markdown formatters for todos/projects/areas/tags/headings
src/someday-filter.ts Hides tasks inside Someday projects from Today/Upcoming/Anytime
src/types.ts          Task/Area/Tag types
```

**Two data paths:**
1. **Reads**: open `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite` in `readonly: true` mode. Schema tables: `TMTask`, `TMArea`, `TMTag`, `TMTaskTag`, `TMAreaTag`, `TMChecklistItem`, `TMSettings`.
2. **Writes**: all writes go through `things:///json` via `spawnSync("open", ["-g", url])`. Update operations require the auth-token read from `TMSettings.uriSchemeAuthenticationToken` (single-row table).

**Bulk-by-default writes**: `add_todos` and `update_todos` take arrays (size 1 is fine). They compile to a single `things:///json?data=[...]` URL. `chunkedJsonUrls` in [src/things-url.ts](src/things-url.ts) splits at ~200 KB to stay under the `open` argv ceiling. For `/json` update operations, `auth-token` goes at the URL level (not per-item) — empirically confirmed.

**Write→read timing**: URL-scheme writes are fire-and-forget, but Things processes them essentially synchronously — empirically the new row is visible in SQLite within ~325 ms of `executeUrl` returning (faster than the MCP roundtrip itself). No post-write sleep is needed; an immediate `get_today` after `add_todos` will see the new tasks. If this ever changes, look in [src/things-url.ts:executeUrl](src/things-url.ts).

**Someday filter**: Things UI hides tasks inside Someday-marked projects from Today/Upcoming/Anytime. The SQLite schema doesn't inherit this — we replicate it client-side in [src/someday-filter.ts](src/someday-filter.ts). The cache is invalidated after any write.

**Today grouping**: When `TMSettings.groupTodayByParent = 1` (a user preference toggleable in Things) the Today view groups tasks by parent project/area instead of showing a flat list. `db.today()` mirrors this. Group ordering rule, reverse-engineered from the live UI: projects tier first, then areas tier, then orphans; within each tier groups sort by the MIN `index` of their constituent tasks (NOT by the parent's own index, and NOT by `todayIndex`). Within a group, tasks keep the `todayIndex` order. See `groupTodayByParent()` at the bottom of [src/things-db.ts](src/things-db.ts).

**Effective list label**: the `start` column only encodes Inbox/Anytime/Someday — Things' visible buckets also include Today and Upcoming, derived from `start` + `startDate`. `effectiveListLabel()` in [src/formatters.ts](src/formatters.ts) maps to what the UI shows, so output reads "List: Today" for a task scheduled today even though its raw start is Anytime/Someday.

## Build & test loop

```bash
bun install                # once
bun run build              # compiles bin/things-mcp (~58 MB arm64 Mach-O)
bun src/index.ts           # run from source without compiling (dev)
npx tsc --noEmit           # typecheck
```

Smoke test the binary directly:
```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_today","arguments":{}}}' \
  | ./bin/things-mcp | tail -1 | python3 -m json.tool
```

After any change that affects MCP behavior, rebuild and prompt the user to restart Claude Desktop — the compiled binary is what Claude actually invokes, not the source.

## Tool design conventions

- All tool inputs are JSON Schema (not Zod) — keeps the dep tree to just `@modelcontextprotocol/sdk`.
- Tool names are snake_case (`get_today`, `add_todos`, etc.). Downstream skills depend on the names, so don't rename without a real reason.
- Output is plain text (markdown-ish), joined by `\n\n---\n\n`. Output shape is stable so downstream skills that parse this output keep working across versions.
- Writes are array-shaped by default (`add_todos`, `update_todos`). Size-1 calls go through the same `/json` path — there are no separate single-vs-bulk variants.

## Rules for changes

- **Don't add a build step beyond `bun run build`.** The whole point of this repo is one clean binary.
- **Don't add runtime dependencies casually.** Today: `@modelcontextprotocol/sdk` only. `bun:sqlite` and `node:child_process` are built into Bun. Adding zod, lodash, or anything else needs a real reason.
- **No comments explaining the obvious.** Code is short; types document themselves. Only comment hidden constraints (e.g., the URL length cap, the singleton-uuid quirk).
- **No backwards-compatibility shims.** Single-author personal tool. If you change a signature, change the call sites.
- **Preserve output stability.** Downstream skills parse this output. Changes to `formatters.ts` need a real reason.
- **Don't touch the MCP client config** (`~/Library/Application Support/Claude/claude_desktop_config.json`) without explicit instruction — that's a manual user-action moment, not something the agent does.

## When adding a new tool

1. Add the handler to [src/tools.ts](src/tools.ts) — `buildTools()` returns the array.
2. Define `inputSchema` as JSON Schema inline. Reuse the `STR`, `STR_ARR`, `BOOL` constants for brevity.
3. If it's a write, call `clearSomedayCache()` after `executeUrl`. The filter is memoized.
4. If it's an update of any kind, call `requireAuth()` and pass the token — the URL scheme rejects updates without it.
5. Add a corresponding `formatters` function only if the output shape is novel; otherwise reuse `formatTodo` etc.
6. Rebuild (`bun run build`), smoke-test with the printf snippet above.

## Things you don't need to handle

- **Cross-platform**: Things is macOS-only. So is this.
- **HTTP transport**: stdio is sufficient for Claude Desktop and Claude Code.
- **Publishing to npm/PyPI**: this is one binary on one machine.
- **Recurrence creation**: Things URL scheme can't create recurring todos. Won't change unless Cultured Code adds it.
- **Checklist-item updates**: the URL scheme doesn't expose checklist items as first-class addressable IDs. Updates replace the whole checklist if at all.
- **Adding a heading to an existing project**: the Things URL scheme silently ignores `items` on `operation: update` for projects, and top-level `{type:"heading"}` items with any project-reference attribute (`list-id`, `project`, `list`) we tried are rejected. Empirically verified May 2026. The only path to creating headings is `add_project` with structured `items` at creation time. If a user needs to add structure to an existing project, they have to do it in the Things UI manually.

## Releasing

`.github/workflows/release.yml` does the heavy lifting. To cut a release:

1. Update `CHANGELOG.md` with a new `## [X.Y.Z]` section describing what changed.
2. Update `"version"` in `package.json` to match.
3. Commit: `git commit -am "Cut vX.Y.Z"`
4. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`
5. Push: `git push origin main && git push origin vX.Y.Z`

The tag push triggers the workflow on a `macos-14` (arm64) runner, which typechecks, builds the binary, stages it as `things-mcp-vX.Y.Z-darwin-arm64`, and uses `softprops/action-gh-release@v2` to create the GitHub Release with auto-generated notes from commits since the previous tag and the binary attached.

Don't rebuild locally and upload manually unless the workflow is broken — the whole point is that this is hands-off after `git push --tags`.

## Reference

- Things URL scheme docs: https://culturedcode.com/things/help/url-scheme/
- things.py (SQL source): https://github.com/thingsapi/things.py
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
