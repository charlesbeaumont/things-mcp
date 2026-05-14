# Changelog

All notable changes to this project. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

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
