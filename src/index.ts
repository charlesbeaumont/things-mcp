#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ThingsDB } from "./things-db.ts";
import { buildTools } from "./tools.ts";

const SERVER_INSTRUCTIONS = `\
This server reads from and writes to Things 3, the macOS task app, on the user's local machine.

Mental model. Tasks live in one of these views:
- Inbox: unsorted captures
- Today: scheduled for today (predicted — includes past-due scheduled tasks and past-deadline tasks)
- Upcoming: scheduled for a future date
- Anytime: no schedule, ready to do
- Someday: deferred indefinitely
- Logbook: completed or canceled

Tasks can sit directly in an Area, or inside a Project (Projects live in Areas; Projects have Headings as sub-sections).

Scheduling syntax for the \`when\` field on add/update tools:
- Keywords: today, tomorrow, evening, anytime, someday
- Dates: YYYY-MM-DD, or natural language ("in 3 days", "next monday")
- Reminders: YYYY-MM-DD@HH:MM (24-hour)

Tool selection rules:
- For reading, prefer the named views (get_today, get_inbox, etc.) when one fits — output matches the Things UI grouping and ordering. Use \`search\` when you need filters (status / dates / tag / area / type / recency) or a full-text query.
- \`add_todos\` and \`update_todos\` always take arrays. Pass an array of 1 for a single todo; pass many to do them all in one URL call. There is no separate single/bulk variant.
- When you have a UUID for a project, area, or heading (from any get_* output), pass it as list_id / heading_id / area_id. The title fallbacks (list, heading, area) match by string and are ambiguous if duplicates exist.
- To create a NEW project with sections (headings) and tasks under each, pass them all to add_project's \`items\` array in one call: \`[{type:'heading', title:'Plan', items:[{title:'Task A'},{title:'Task B'}]}, {type:'heading', title:'Build', items:[...]}]\`. Adding a heading to an EXISTING project is not supported by the Things URL scheme — if a project needs new structure, either create the project that way from the start or have the user add the heading in the Things UI manually.

Updates need the task UUID. Every read tool surfaces it as "UUID: ..." in the output. After add_todos the new tasks are visible in SQLite within ~1 second; re-read the relevant view if you need the new UUIDs for follow-up.

Not supported (Things URL-scheme limitations): recurring/repeating tasks on create, updating individual checklist items.
`;

async function main(): Promise<void> {
  const db = new ThingsDB();
  const tools = buildTools(db);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "things-mcp", version: "0.2.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text" as const, text: `Unknown tool: ${request.params.name}` },
        ],
        isError: true,
      };
    }
    try {
      const text = tool.handler((request.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stdio servers exit when the parent closes stdin; bun:sqlite is closed on
  // process exit. No explicit shutdown needed.
}

main().catch((err) => {
  // Log to stderr so it doesn't corrupt the stdio JSON-RPC channel
  console.error("things-mcp fatal:", err);
  process.exit(1);
});
