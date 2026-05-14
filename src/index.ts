#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ThingsDB } from "./things-db.ts";
import { buildTools } from "./tools.ts";

async function main(): Promise<void> {
  const db = new ThingsDB();
  const tools = buildTools(db);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "things-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
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
