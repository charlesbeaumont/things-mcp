import { ThingsDB } from "./things-db.ts";
import {
  formatArea,
  formatHeading,
  formatProject,
  formatTag,
  formatTodo,
  joinFormatted,
} from "./formatters.ts";
import {
  filterSomedayProjectTasks,
  expandSomedayWithProjectMembers,
  clearSomedayCache,
} from "./someday-filter.ts";
import {
  addProjectUrl,
  addTodoUrl,
  chunkedJsonUrls,
  executeUrl,
  type JsonItem,
  type JsonTodoAttributes,
  searchUrl,
  showUrl,
  updateProjectUrl,
  updateTodoUrl,
} from "./things-url.ts";
import type { TaskStatus, TaskType } from "./types.ts";

type Args = Record<string, unknown>;
type Handler = (args: Args) => string;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: Handler;
}

function reqString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return v;
}

function optString(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

function optStringArray(args: Args, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

const STR = { type: "string" } as const;
const STR_ARR = { type: "array", items: { type: "string" } } as const;
const BOOL = { type: "boolean" } as const;

export function buildTools(db: ThingsDB): ToolDef[] {
  const tools: ToolDef[] = [];
  const requireAuth = (): string => {
    const t = db.getAuthToken();
    if (!t) throw new Error("Could not read Things URL-scheme auth token");
    return t;
  };

  // ---------- Read tools ----------

  tools.push({
    name: "get_inbox",
    description: "Get todos from Inbox",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () =>
      joinFormatted(db.inbox().map((t) => formatTodo(db, t))),
  });

  tools.push({
    name: "get_today",
    description: "Get todos due today",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const todos = filterSomedayProjectTasks(db, db.today());
      return joinFormatted(todos.map((t) => formatTodo(db, t)));
    },
  });

  tools.push({
    name: "get_upcoming",
    description: "Get upcoming todos",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const todos = filterSomedayProjectTasks(db, db.upcoming());
      return joinFormatted(todos.map((t) => formatTodo(db, t)));
    },
  });

  tools.push({
    name: "get_anytime",
    description: "Get todos from Anytime list",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const todos = filterSomedayProjectTasks(db, db.anytime());
      return joinFormatted(todos.map((t) => formatTodo(db, t)));
    },
  });

  tools.push({
    name: "get_someday",
    description: "Get todos from Someday list, including tasks in Someday projects",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const someday = db.someday();
      const anytime = db.anytime();
      const merged = expandSomedayWithProjectMembers(db, someday, anytime);
      return joinFormatted(merged.map((t) => formatTodo(db, t)));
    },
  });

  tools.push({
    name: "get_logbook",
    description:
      "Get completed todos from Logbook (defaults to last 7 days, max 50)",
    inputSchema: {
      type: "object",
      properties: {
        period: { ...STR, description: "Time period (e.g., '3d', '1w', '1y'). Defaults to '7d'." },
        limit: { type: "integer", description: "Max entries. Defaults to 50." },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const period = optString(a, "period") ?? "7d";
      const limit = typeof a.limit === "number" ? a.limit : 50;
      const todos = db.logbook(period).slice(0, limit);
      return joinFormatted(todos.map((t) => formatTodo(db, t)));
    },
  });

  tools.push({
    name: "get_trash",
    description: "Get trashed todos",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => joinFormatted(db.trash().map((t) => formatTodo(db, t))),
  });

  tools.push({
    name: "get_todos",
    description: "Get todos from Things, optionally filtered by project",
    inputSchema: {
      type: "object",
      properties: {
        project_uuid: { ...STR, description: "Project UUID to filter by" },
        include_items: { ...BOOL, description: "Include checklist items" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const projectUuid = optString(a, "project_uuid");
      const includeItems = optBool(a, "include_items") ?? true;
      if (projectUuid) {
        const proj = db.get(projectUuid, false);
        if (!proj || proj.type !== "project")
          return `Error: Invalid project UUID '${projectUuid}'`;
      }
      const todos = db.todos(projectUuid, includeItems);
      return joinFormatted(todos.map((t) => formatTodo(db, t)));
    },
  });

  tools.push({
    name: "get_projects",
    description: "Get all projects from Things",
    inputSchema: {
      type: "object",
      properties: {
        include_items: { ...BOOL, description: "Include tasks within projects" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const includeItems = optBool(a, "include_items") ?? false;
      const projects = db.projects(includeItems);
      return joinFormatted(projects.map((p) => formatProject(db, p, includeItems)));
    },
  });

  tools.push({
    name: "get_areas",
    description: "Get all areas from Things",
    inputSchema: {
      type: "object",
      properties: {
        include_items: { ...BOOL, description: "Include projects and tasks within areas" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const includeItems = optBool(a, "include_items") ?? false;
      const areas = db.getAreas();
      return joinFormatted(areas.map((ar) => formatArea(db, ar, includeItems)));
    },
  });

  tools.push({
    name: "get_tags",
    description: "Get all tags",
    inputSchema: {
      type: "object",
      properties: {
        include_items: { ...BOOL, description: "Include items tagged with each tag" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const includeItems = optBool(a, "include_items") ?? false;
      const tags = db.getTags();
      return joinFormatted(tags.map((t) => formatTag(db, t, includeItems)));
    },
  });

  tools.push({
    name: "get_tagged_items",
    description: "Get items with a specific tag",
    inputSchema: {
      type: "object",
      properties: {
        tag: { ...STR, description: "Tag title to filter by" },
      },
      required: ["tag"],
      additionalProperties: false,
    },
    handler: (a) => {
      const tag = reqString(a, "tag");
      const todos = db.taggedItems(tag);
      if (todos.length === 0) return `No items found with tag '${tag}'`;
      return joinFormatted(todos.map((t) => formatTodo(db, t)));
    },
  });

  tools.push({
    name: "get_headings",
    description: "Get headings, optionally filtered to one project",
    inputSchema: {
      type: "object",
      properties: {
        project_uuid: { ...STR, description: "Project UUID to filter by" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const projectUuid = optString(a, "project_uuid");
      if (projectUuid) {
        const proj = db.get(projectUuid, false);
        if (!proj || proj.type !== "project")
          return `Error: Invalid project UUID '${projectUuid}'`;
      }
      const headings = db.headings(projectUuid);
      return joinFormatted(headings.map((h) => formatHeading(db, h)));
    },
  });

  tools.push({
    name: "search_todos",
    description: "Search todos by title or notes",
    inputSchema: {
      type: "object",
      properties: {
        query: { ...STR, description: "Search term" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (a) => {
      const q = reqString(a, "query");
      const todos = db.search(q);
      if (todos.length === 0) return `No todos found matching '${q}'`;
      return joinFormatted(todos.map((t) => formatTodo(db, t)));
    },
  });

  tools.push({
    name: "search_advanced",
    description: "Advanced todo search with multiple filters",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["incomplete", "completed", "canceled"],
          description: "Filter by status",
        },
        start_date: { ...STR, description: "Filter by start date (YYYY-MM-DD)" },
        deadline: { ...STR, description: "Filter by deadline (YYYY-MM-DD)" },
        tag: { ...STR, description: "Filter by tag" },
        area: { ...STR, description: "Filter by area UUID" },
        type: {
          type: "string",
          enum: ["to-do", "project", "heading"],
          description: "Filter by item type",
        },
        last: { ...STR, description: "Creation-date offset (e.g., '3d')" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const tasks = db.getTasks({
        status: (optString(a, "status") as TaskStatus | undefined) ?? "incomplete",
        start_date: optString(a, "start_date"),
        deadline: optString(a, "deadline"),
        tag: optString(a, "tag"),
        area: optString(a, "area"),
        type: optString(a, "type") as TaskType | undefined,
        last: optString(a, "last"),
      });
      db.hydrateTasks(tasks, true);
      if (tasks.length === 0) return "No matching todos found";
      return joinFormatted(tasks.map((t) => formatTodo(db, t)));
    },
  });

  tools.push({
    name: "get_recent",
    description: "Get recently created items within a time period",
    inputSchema: {
      type: "object",
      properties: {
        period: { ...STR, description: "Period (e.g., '3d', '1w', '1y')" },
      },
      required: ["period"],
      additionalProperties: false,
    },
    handler: (a) => {
      const period = reqString(a, "period");
      const todos = db.last(period);
      if (todos.length === 0) return `No items found in the last ${period}`;
      return joinFormatted(todos.map((t) => formatTodo(db, t)));
    },
  });

  // ---------- Write tools ----------

  const addTodoSchema = {
    type: "object",
    properties: {
      title: { ...STR, description: "Title of the todo" },
      notes: { ...STR, description: "Notes for the todo" },
      when: {
        ...STR,
        description:
          "Schedule: today/tomorrow/evening/anytime/someday/YYYY-MM-DD. Use YYYY-MM-DD@HH:MM for reminder.",
      },
      deadline: { ...STR, description: "Deadline (YYYY-MM-DD)" },
      tags: { ...STR_ARR, description: "Tag names" },
      checklist_items: { ...STR_ARR, description: "Checklist item titles" },
      list_id: { ...STR, description: "Project/area UUID" },
      list_title: { ...STR, description: "Project/area title" },
      heading: { ...STR, description: "Heading title" },
      heading_id: { ...STR, description: "Heading UUID (takes precedence over heading)" },
    },
    required: ["title"],
    additionalProperties: false,
  };

  tools.push({
    name: "add_todo",
    description: "Create a new todo in Things",
    inputSchema: addTodoSchema,
    handler: (a) => {
      const title = reqString(a, "title");
      const url = addTodoUrl({
        title,
        notes: optString(a, "notes"),
        when: optString(a, "when"),
        deadline: optString(a, "deadline"),
        tags: optStringArray(a, "tags"),
        "checklist-items": optStringArray(a, "checklist_items"),
        "list-id": optString(a, "list_id"),
        list: optString(a, "list_title"),
        heading: optString(a, "heading"),
        "heading-id": optString(a, "heading_id"),
      });
      executeUrl(url);
      clearSomedayCache();
      return `Created new todo: ${title}`;
    },
  });

  tools.push({
    name: "add_project",
    description: "Create a new project in Things",
    inputSchema: {
      type: "object",
      properties: {
        title: { ...STR, description: "Title of the project" },
        notes: { ...STR, description: "Notes" },
        when: {
          ...STR,
          description: "Schedule (today/tomorrow/evening/anytime/someday/YYYY-MM-DD)",
        },
        deadline: { ...STR, description: "Deadline (YYYY-MM-DD)" },
        tags: { ...STR_ARR, description: "Tag names" },
        area_id: { ...STR, description: "Area UUID" },
        area_title: { ...STR, description: "Area title" },
        todos: { ...STR_ARR, description: "Initial todo titles" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    handler: (a) => {
      const title = reqString(a, "title");
      const url = addProjectUrl({
        title,
        notes: optString(a, "notes"),
        when: optString(a, "when"),
        deadline: optString(a, "deadline"),
        tags: optStringArray(a, "tags"),
        "area-id": optString(a, "area_id"),
        area: optString(a, "area_title"),
        "to-dos": optStringArray(a, "todos"),
      });
      executeUrl(url);
      clearSomedayCache();
      return `Created new project: ${title}`;
    },
  });

  tools.push({
    name: "update_todo",
    description: "Update an existing todo in Things",
    inputSchema: {
      type: "object",
      properties: {
        id: { ...STR, description: "UUID of the todo to update" },
        title: { ...STR, description: "New title" },
        notes: { ...STR, description: "New notes" },
        when: { ...STR, description: "New schedule" },
        deadline: { ...STR, description: "New deadline (YYYY-MM-DD)" },
        tags: { ...STR_ARR, description: "New tags (replaces existing)" },
        completed: { ...BOOL, description: "Mark as completed" },
        canceled: { ...BOOL, description: "Mark as canceled" },
        list: { ...STR, description: "Project/area title to move to" },
        list_id: { ...STR, description: "Project/area UUID to move to" },
        heading: { ...STR, description: "Heading title" },
        heading_id: { ...STR, description: "Heading UUID" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (a) => {
      const id = reqString(a, "id");
      const url = updateTodoUrl(
        {
          id,
          title: optString(a, "title"),
          notes: optString(a, "notes"),
          when: optString(a, "when"),
          deadline: optString(a, "deadline"),
          tags: optStringArray(a, "tags"),
          completed: optBool(a, "completed"),
          canceled: optBool(a, "canceled"),
          list: optString(a, "list"),
          "list-id": optString(a, "list_id"),
          heading: optString(a, "heading"),
          "heading-id": optString(a, "heading_id"),
        },
        requireAuth(),
      );
      executeUrl(url);
      clearSomedayCache();
      return `Updated todo with ID: ${id}`;
    },
  });

  tools.push({
    name: "update_project",
    description: "Update an existing project in Things",
    inputSchema: {
      type: "object",
      properties: {
        id: { ...STR, description: "UUID of the project to update" },
        title: { ...STR, description: "New title" },
        notes: { ...STR, description: "New notes" },
        when: { ...STR, description: "New schedule" },
        deadline: { ...STR, description: "New deadline (YYYY-MM-DD)" },
        tags: { ...STR_ARR, description: "New tags (replaces existing)" },
        completed: { ...BOOL, description: "Mark as completed" },
        canceled: { ...BOOL, description: "Mark as canceled" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (a) => {
      const id = reqString(a, "id");
      const url = updateProjectUrl(
        {
          id,
          title: optString(a, "title"),
          notes: optString(a, "notes"),
          when: optString(a, "when"),
          deadline: optString(a, "deadline"),
          tags: optStringArray(a, "tags"),
          completed: optBool(a, "completed"),
          canceled: optBool(a, "canceled"),
        },
        requireAuth(),
      );
      executeUrl(url);
      clearSomedayCache();
      return `Updated project with ID: ${id}`;
    },
  });

  // ---------- Bulk write tools (Things /json endpoint) ----------

  const bulkTodoAttrSchema = {
    type: "object",
    properties: {
      title: STR,
      notes: STR,
      when: STR,
      deadline: STR,
      tags: STR_ARR,
      checklist_items: STR_ARR,
      list_id: STR,
      list: STR,
      heading: STR,
      heading_id: STR,
      completed: BOOL,
      canceled: BOOL,
    },
    additionalProperties: false,
  };

  function todoAttrsToJsonAttrs(a: Args): JsonTodoAttributes {
    const checklist = optStringArray(a, "checklist_items");
    return {
      title: optString(a, "title"),
      notes: optString(a, "notes"),
      when: optString(a, "when"),
      deadline: optString(a, "deadline"),
      tags: optStringArray(a, "tags"),
      ...(checklist
        ? {
            "checklist-items": checklist.map((title) => ({
              type: "checklist-item" as const,
              attributes: { title },
            })),
          }
        : {}),
      "list-id": optString(a, "list_id"),
      list: optString(a, "list"),
      heading: optString(a, "heading"),
      "heading-id": optString(a, "heading_id"),
      completed: optBool(a, "completed"),
      canceled: optBool(a, "canceled"),
    };
  }

  tools.push({
    name: "bulk_add_todos",
    description:
      "Create many todos in a single Things URL call. Faster than calling add_todo repeatedly.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Array of todo specs, each with the same fields as add_todo (title required)",
          items: {
            ...bulkTodoAttrSchema,
            required: ["title"],
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    handler: (a) => {
      const todos = a.todos;
      if (!Array.isArray(todos) || todos.length === 0)
        throw new Error("`todos` must be a non-empty array");
      const items: JsonItem[] = todos.map((raw, i) => {
        if (typeof raw !== "object" || raw === null)
          throw new Error(`todos[${i}] must be an object`);
        const attrs = todoAttrsToJsonAttrs(raw as Args);
        if (!attrs.title) throw new Error(`todos[${i}].title is required`);
        return { type: "to-do" as const, operation: "create" as const, attributes: attrs };
      });
      const urls = chunkedJsonUrls(items);
      for (const url of urls) executeUrl(url);
      clearSomedayCache();
      return `Created ${todos.length} todo${todos.length === 1 ? "" : "s"}${
        urls.length > 1 ? ` (in ${urls.length} batches due to URL length)` : ""
      }`;
    },
  });

  tools.push({
    name: "bulk_update_todos",
    description:
      "Update many todos in a single Things URL call. Pass an array of {id, ...changes}.",
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          description: "Array of update specs",
          items: {
            type: "object",
            properties: {
              id: { ...STR, description: "UUID of the todo to update" },
              ...bulkTodoAttrSchema.properties,
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["updates"],
      additionalProperties: false,
    },
    handler: (a) => {
      const token = requireAuth();
      const updates = a.updates;
      if (!Array.isArray(updates) || updates.length === 0)
        throw new Error("`updates` must be a non-empty array");
      const items: JsonItem[] = updates.map((raw, i) => {
        if (typeof raw !== "object" || raw === null)
          throw new Error(`updates[${i}] must be an object`);
        const id = reqString(raw as Args, "id");
        return {
          type: "to-do" as const,
          operation: "update" as const,
          id,
          attributes: todoAttrsToJsonAttrs(raw as Args),
        };
      });
      const urls = chunkedJsonUrls(items, token);
      for (const url of urls) executeUrl(url);
      clearSomedayCache();
      return `Updated ${updates.length} todo${updates.length === 1 ? "" : "s"}${
        urls.length > 1 ? ` (in ${urls.length} batches due to URL length)` : ""
      }`;
    },
  });

  // ---------- UI navigation tools ----------

  tools.push({
    name: "show_item",
    description: "Bring up a specific item or list in the Things UI",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          ...STR,
          description:
            "Item UUID, or one of: inbox/today/upcoming/anytime/someday/logbook",
        },
        query: { ...STR, description: "Optional query to filter by" },
        filter_tags: { ...STR_ARR, description: "Optional tags to filter by" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (a) => {
      const id = reqString(a, "id");
      executeUrl(
        showUrl(id, optString(a, "query"), optStringArray(a, "filter_tags")),
      );
      return `Showing item: ${id}`;
    },
  });

  tools.push({
    name: "search_items",
    description: "Open the Things UI search for a query",
    inputSchema: {
      type: "object",
      properties: {
        query: { ...STR, description: "Search query" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (a) => {
      const q = reqString(a, "query");
      executeUrl(searchUrl(q));
      return `Searching for '${q}'`;
    },
  });

  return tools;
}
