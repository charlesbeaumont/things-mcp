# Changelog

All notable changes to this project. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] — 2026-05-15

Tool surface consolidated from 24 to 17. Heading creation supported for new projects. Breaking changes to `add_project`, `add_todo` → `add_todos`, and `update_todo` → `update_todos`.

### Removed

- `add_todo`, `bulk_add_todos`, `update_todo`, `bulk_update_todos` — collapsed into `add_todos` / `update_todos` (always array-shaped; size-1 calls work the same).
- `search_todos`, `search_advanced`, `get_recent`, `get_tagged_items` — collapsed into one `search` tool.
- `show_item`, `search_items` — UI-navigation tools that brought Things to the foreground. Easy to re-add if a real need shows up.

### Added

- `add_todos(todos: TodoSpec[])` — one or many in a single `/json` URL call. Same fields as the old `add_todo` plus an array wrapper.
- `update_todos(updates: UpdateSpec[])` — one or many; each entry must include `id`. Requires the URL-scheme auth token, read automatically from `TMSettings`.
- `search(query?, status?, start_date?, deadline?, tag?, area?, type?, last?)` — full-text and/or filter, all parameters optional. `last` triggers newest-first sort, matching the old `get_recent`.
- `add_project` now accepts a structured `items: Item[]` where each entry is `{type: "to-do", title, ...}` or `{type: "heading", title, items: [...todos]}`. Heading children are a shorthand for setting `heading: <title>` on each nested todo. Handler routes through `things:///json` to support nested structure.
- `JsonItem` union in [src/things-url.ts](src/things-url.ts) gained a `heading` variant: `{type: "heading", attributes: {title, archived?}}`. Headings are nested-only inside a project's `items` array — Things' URL scheme rejects them at the JSON top level.

### Changed (breaking)

- `add_project`: `todos: string[]` removed. Migrate `{todos: ["a", "b"]}` → `{items: [{type: "to-do", title: "a"}, {type: "to-do", title: "b"}]}`, or use headings: `{items: [{type: "heading", title: "Plan", items: [{title: "a"}, {title: "b"}]}]}`.
- Single-item write callers move to the array shape: `add_todo({title}) → add_todos({todos: [{title}]})`, `update_todo({id, …}) → update_todos({updates: [{id, …}]})`.
- Search callers move to `search`: `search_todos({query}) → search({query})`, `search_advanced({tag}) → search({tag})`, `get_recent({period}) → search({last: period})`, `get_tagged_items({tag}) → search({tag})`.
- Server `instructions` updated to teach the new shapes.

### Empirically verified — not supported

- **Adding a heading to an existing project**: Things' `/json` with `operation: "update"` on a project silently ignores the `items` field. Top-level `{type: "heading"}` items with any project-reference attribute (`list-id`, `project`, `list`) we tried were also rejected. No `add_heading` tool ships; the only heading-creation path is `add_project` at creation time. Documented in CLAUDE.md and the server instructions.

### Tool inventory (17)

- **Named list views (7)**: `get_inbox`, `get_today`, `get_upcoming`, `get_anytime`, `get_someday`, `get_logbook`, `get_trash`
- **Entity listings (5)**: `get_todos`, `get_projects`, `get_areas`, `get_tags`, `get_headings`
- **Search (1)**: `search`
- **Todo writes (2)**: `add_todos`, `update_todos`
- **Project writes (2)**: `add_project` (now with `items`), `update_project`

## [0.1.0] — 2026-05-14

First working release. Single Bun-compiled binary, 24 tools, validated end-to-end against a live Things 3 database.

### Added

- 16 read tools (`get_inbox`, `get_today`, `get_upcoming`, `get_anytime`, `get_someday`, `get_logbook`, `get_trash`, `get_todos`, `get_projects`, `get_areas`, `get_tags`, `get_tagged_items`, `get_headings`, `search_todos`, `search_advanced`, `get_recent`).
- 4 single-item write tools (`add_todo`, `add_project`, `update_todo`, `update_project`).
- 2 bulk write tools (`bulk_add_todos`, `bulk_update_todos`) using Things' `/json` URL-scheme endpoint. Auto-chunks at ~200 KB to stay under the macOS `open` argv ceiling.
- 2 UI navigation tools (`show_item`, `search_items`).
- `bun run build` produces a standalone ~58 MB arm64 binary that needs no Node/Bun/uv at runtime.
- `install.sh` for one-shot build + dequarantine + config-snippet print.

### Behavior parity with the Things UI

- **Someday-project filter**: tasks inside a project marked Someday are hidden from Today/Upcoming/Anytime, matching what the UI shows. 60s TTL cache.
- **Group Today by parent**: when `TMSettings.groupTodayByParent = 1`, `get_today` mirrors the UI's grouped layout — projects tier first then areas tier, groups sorted by the min `index` of their constituent tasks.
- **Effective list label**: output shows "List: Today" / "Upcoming" derived from `start + startDate`, not the misleading raw `start` value (which only encodes Inbox/Anytime/Someday).
- **Inherited Someday**: tasks whose own start ≠ Someday but parent project's start = Someday show "List: Someday (inherited from project)".

### Hardening

- Drop `osascript "do shell script open -g"` wrapper; use `spawnSync("open", ["-g", url])` directly. Removes the Automation TCC prompt and shell-escaping bug surface.
- Pin `@modelcontextprotocol/sdk` to `1.29.0` (was `^1.0.0`).
- Assert `Meta.databaseVersion ≥ 22` on startup (matches `things.py`); fail loudly instead of silently producing wrong queries against a future schema.
- Read URL-scheme auth-token via `SELECT … LIMIT 1` instead of the hardcoded singleton UUID `RhAzEf6qDxCD5PmnZVtBZR`.
- Extend the task JOIN with `project_of_heading`, `project_start`, and `project_of_heading_start` so `formatTodo` needs zero per-task DB lookups (~10× faster on large lists).

### Verified

- All write tools tested end-to-end against the live DB (add/update/bulk × todo/project, both `completed: true` and `canceled: true`).
- Write→read sync gap measured at ~325 ms; no post-write sleep needed.
- `get_today` output diffed against the live Things UI screenshot — exact match after the grouping fix.

### Known limitations (deliberate, not bugs)

- macOS-only (Things is macOS-only).
- No recurrence-on-create (the Things URL scheme doesn't support it).
- No checklist-item updates (URL scheme doesn't expose them as addressable IDs).
- stdio transport only.

[0.1.0]: https://github.com/charlesbeaumont/things-mcp/releases/tag/v0.1.0
