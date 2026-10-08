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
  chunkedJsonUrls,
  executeUrl,
  type JsonItem,
  type JsonProjectAttributes,
  type JsonTodoAttributes,
  updateProjectUrl,
} from "./things-url.ts";
import {
  ADD_PROJECT_OUTPUT,
  ADD_TODOS_OUTPUT,
  AREAS_OUTPUT,
  areaJson,
  HEADINGS_OUTPUT,
  headingJson,
  PROJECTS_OUTPUT,
  projectJson,
  TAGS_OUTPUT,
  tagJson,
  TODOS_OUTPUT,
  todoJson,
  UPDATE_PROJECT_OUTPUT,
  UPDATE_TODOS_OUTPUT,
} from "./structured.ts";
import type { Task, TaskStatus, TaskType } from "./types.ts";

type Args = Record<string, unknown>;

// `text` keeps the stable plain-text shape downstream skills parse;
// `structured` is the same data as JSON, matching the tool's outputSchema.
export interface ToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface ToolContext {
  // Resolves true when the user approves, or when the client can't ask.
  confirm(message: string): Promise<boolean>;
}

type Handler = (args: Args, ctx: ToolContext) => ToolResult | Promise<ToolResult>;

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  annotations?: ToolAnnotations;
  handler: Handler;
}

// Completing or canceling this many todos in one call asks the user first.
const CONFIRM_BULK_CLOSE_AT = 5;

// All tools touch a local SQLite DB or the local Things URL scheme — never the network.
const LOCAL = { openWorldHint: false } as const;
const READ: ToolAnnotations = { readOnlyHint: true, ...LOCAL };
const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  ...LOCAL,
};
const UPDATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  ...LOCAL,
};

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
  const todoList = (todos: Task[], emptyText?: string): ToolResult => ({
    text:
      todos.length === 0 && emptyText
        ? emptyText
        : joinFormatted(todos.map((t) => formatTodo(db, t))),
    structured: { todos: todos.map(todoJson) },
  });
  const requireProject = (uuid: string): void => {
    const proj = db.get(uuid, false);
    if (!proj || proj.type !== "project") throw new Error(`Invalid project UUID '${uuid}'`);
  };

  // ---------- Read tools ----------

  tools.push({
    name: "get_inbox",
    description: "Get todos from Inbox (unsorted captures with no list assigned).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: TODOS_OUTPUT,
    annotations: READ,
    handler: () => todoList(db.inbox()),
  });

  tools.push({
    name: "get_today",
    description:
      "Get the Today list — scheduled for today, plus past-due scheduled tasks and past-deadline tasks. Output mirrors the Things UI grouping (by parent project/area) when that setting is enabled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: TODOS_OUTPUT,
    annotations: READ,
    handler: () => todoList(filterSomedayProjectTasks(db, db.today())),
  });

  tools.push({
    name: "get_upcoming",
    description: "Get tasks scheduled for future dates (Things' Upcoming view).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: TODOS_OUTPUT,
    annotations: READ,
    handler: () => todoList(filterSomedayProjectTasks(db, db.upcoming())),
  });

  tools.push({
    name: "get_anytime",
    description: "Get the Anytime list — tasks ready to do with no specific schedule.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: TODOS_OUTPUT,
    annotations: READ,
    handler: () => todoList(filterSomedayProjectTasks(db, db.anytime())),
  });

  tools.push({
    name: "get_someday",
    description:
      "Get the Someday list — deferred tasks. Includes tasks living inside projects marked Someday (which the raw SQL would otherwise miss).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: TODOS_OUTPUT,
    annotations: READ,
    handler: () =>
      todoList(expandSomedayWithProjectMembers(db, db.someday(), db.anytime())),
  });

  tools.push({
    name: "get_logbook",
    description:
      "Get completed and canceled tasks from the Logbook over a time period (defaults to last 7 days, max 50 items).",
    inputSchema: {
      type: "object",
      properties: {
        period: { ...STR, description: "Time period (e.g., '3d', '1w', '1y'). Defaults to '7d'." },
        limit: { type: "integer", description: "Max entries. Defaults to 50." },
      },
      additionalProperties: false,
    },
    outputSchema: TODOS_OUTPUT,
    annotations: READ,
    handler: (a) => {
      const period = optString(a, "period") ?? "7d";
      const limit = typeof a.limit === "number" ? a.limit : 50;
      return todoList(db.logbook(period).slice(0, limit));
    },
  });

  tools.push({
    name: "get_trash",
    description: "Get trashed todos.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: TODOS_OUTPUT,
    annotations: READ,
    handler: () => todoList(db.trash()),
  });

  tools.push({
    name: "get_todos",
    description: "Get all todos, optionally filtered to a single project by UUID.",
    inputSchema: {
      type: "object",
      properties: {
        project_uuid: { ...STR, description: "Project UUID to filter by" },
        include_items: { ...BOOL, description: "Include checklist items" },
      },
      additionalProperties: false,
    },
    outputSchema: TODOS_OUTPUT,
    annotations: READ,
    handler: (a) => {
      const projectUuid = optString(a, "project_uuid");
      const includeItems = optBool(a, "include_items") ?? true;
      if (projectUuid) requireProject(projectUuid);
      return todoList(db.todos(projectUuid, includeItems));
    },
  });

  tools.push({
    name: "get_projects",
    description: "Get all active projects.",
    inputSchema: {
      type: "object",
      properties: {
        include_items: { ...BOOL, description: "Include tasks within projects" },
      },
      additionalProperties: false,
    },
    outputSchema: PROJECTS_OUTPUT,
    annotations: READ,
    handler: (a) => {
      const includeItems = optBool(a, "include_items") ?? false;
      const projects = db.projects(includeItems);
      return {
        text: joinFormatted(projects.map((p) => formatProject(db, p, includeItems))),
        structured: { projects: projects.map((p) => projectJson(db, p, includeItems)) },
      };
    },
  });

  tools.push({
    name: "get_areas",
    description: "Get all areas (top-level life buckets that contain projects and standalone tasks).",
    inputSchema: {
      type: "object",
      properties: {
        include_items: { ...BOOL, description: "Include projects and tasks within areas" },
      },
      additionalProperties: false,
    },
    outputSchema: AREAS_OUTPUT,
    annotations: READ,
    handler: (a) => {
      const includeItems = optBool(a, "include_items") ?? false;
      const areas = db.getAreas();
      return {
        text: joinFormatted(areas.map((ar) => formatArea(db, ar, includeItems))),
        structured: { areas: areas.map((ar) => areaJson(db, ar, includeItems)) },
      };
    },
  });

  tools.push({
    name: "get_tags",
    description: "Get all tag definitions.",
    inputSchema: {
      type: "object",
      properties: {
        include_items: { ...BOOL, description: "Include items tagged with each tag" },
      },
      additionalProperties: false,
    },
    outputSchema: TAGS_OUTPUT,
    annotations: READ,
    handler: (a) => {
      const includeItems = optBool(a, "include_items") ?? false;
      const tags = db.getTags();
      return {
        text: joinFormatted(tags.map((t) => formatTag(db, t, includeItems))),
        structured: { tags: tags.map((t) => tagJson(db, t, includeItems)) },
      };
    },
  });

  tools.push({
    name: "get_headings",
    description: "Get project headings (sub-sections), optionally scoped to one project.",
    inputSchema: {
      type: "object",
      properties: {
        project_uuid: { ...STR, description: "Project UUID to filter by" },
      },
      additionalProperties: false,
    },
    outputSchema: HEADINGS_OUTPUT,
    annotations: READ,
    handler: (a) => {
      const projectUuid = optString(a, "project_uuid");
      if (projectUuid) requireProject(projectUuid);
      const headings = db.headings(projectUuid);
      return {
        text: joinFormatted(headings.map((h) => formatHeading(db, h))),
        structured: { headings: headings.map(headingJson) },
      };
    },
  });

  tools.push({
    name: "search",
    description:
      "Search todos by full-text query and/or any combination of filters (status, dates, tag, area, type, creation recency). All parameters are optional; combine any. Prefer the named views (get_today, get_inbox, etc.) when one fits — they match the Things UI ordering and grouping.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          ...STR,
          description: "Full-text across todo titles, notes, and parent area names",
        },
        status: {
          type: "string",
          enum: ["incomplete", "completed", "canceled"],
          description: "Default: incomplete",
        },
        start_date: { ...STR, description: "YYYY-MM-DD" },
        deadline: { ...STR, description: "YYYY-MM-DD" },
        tag: { ...STR, description: "Tag title" },
        area: { ...STR, description: "Area UUID" },
        type: {
          type: "string",
          enum: ["to-do", "project", "heading"],
        },
        last: {
          ...STR,
          description:
            "Creation-date offset (e.g., '3d', '1w', '1y'). When set, results sorted newest-first.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: TODOS_OUTPUT,
    annotations: READ,
    handler: (a) => {
      const status =
        (optString(a, "status") as TaskStatus | undefined) ?? "incomplete";
      const tasks = db.getTasks({
        status,
        search_query: optString(a, "query"),
        start_date: optString(a, "start_date"),
        deadline: optString(a, "deadline"),
        tag: optString(a, "tag"),
        area: optString(a, "area"),
        type: optString(a, "type") as TaskType | undefined,
        last: optString(a, "last"),
      });
      if (optString(a, "last")) {
        tasks.sort((x, y) => {
          const xd = x.created ?? "";
          const yd = y.created ?? "";
          return xd < yd ? 1 : xd > yd ? -1 : 0;
        });
      }
      db.hydrateTasks(tasks, true);
      return todoList(tasks, "No matching todos found");
    },
  });

  // ---------- Write tools ----------

  const todoSpecSchema = {
    type: "object",
    properties: {
      title: { ...STR, description: "Todo title" },
      notes: STR,
      when: {
        ...STR,
        description:
          "Schedule: today/tomorrow/evening/anytime/someday/YYYY-MM-DD. Use YYYY-MM-DD@HH:MM to set a reminder.",
      },
      deadline: { ...STR, description: "Deadline (YYYY-MM-DD)" },
      tags: { ...STR_ARR, description: "Tag names" },
      checklist_items: STR_ARR,
      list_id: { ...STR, description: "Project/area UUID (preferred)" },
      list_title: { ...STR, description: "Project/area title (fallback)" },
      heading: { ...STR, description: "Heading title within the list" },
      heading_id: { ...STR, description: "Heading UUID (preferred over heading)" },
    },
    required: ["title"],
    additionalProperties: false,
  };

  function todoSpecToJsonAttrs(a: Args): JsonTodoAttributes {
    const checklist = toJsonChecklist(optStringArray(a, "checklist_items"));
    return {
      title: optString(a, "title"),
      notes: optString(a, "notes"),
      when: optString(a, "when"),
      deadline: optString(a, "deadline"),
      tags: optStringArray(a, "tags"),
      ...(checklist ? { "checklist-items": checklist } : {}),
      "list-id": optString(a, "list_id"),
      list: optString(a, "list_title"),
      heading: optString(a, "heading"),
      "heading-id": optString(a, "heading_id"),
    };
  }

  tools.push({
    name: "add_todos",
    description:
      "Create one or more todos in a single Things URL call. Pass an array; size 1 is fine. All todos in the array land in one invocation (no per-task badge bounce in the Things dock icon).",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          minItems: 1,
          description: "Array of todo specs. Pass [{title: '...'}] for a single todo.",
          items: todoSpecSchema,
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    outputSchema: ADD_TODOS_OUTPUT,
    annotations: CREATE,
    handler: (a) => {
      const todos = a.todos;
      if (!Array.isArray(todos) || todos.length === 0)
        throw new Error("`todos` must be a non-empty array");
      const items: JsonItem[] = todos.map((raw, i) => {
        if (typeof raw !== "object" || raw === null)
          throw new Error(`todos[${i}] must be an object`);
        const attrs = todoSpecToJsonAttrs(raw as Args);
        if (!attrs.title) throw new Error(`todos[${i}].title is required`);
        return {
          type: "to-do" as const,
          operation: "create" as const,
          attributes: attrs,
        };
      });
      const urls = chunkedJsonUrls(items);
      for (const url of urls) executeUrl(url);
      clearSomedayCache();
      const n = todos.length;
      return {
        text: `Created ${n} todo${n === 1 ? "" : "s"}${urls.length > 1 ? ` (in ${urls.length} batches due to URL length)` : ""}`,
        structured: { created: n, batches: urls.length },
      };
    },
  });

  // Shared inner shape for a todo inside add_project's `items` array.
  const projectItemTodoSchema = {
    type: "object",
    properties: {
      type: { const: "to-do" },
      title: { ...STR, description: "Todo title" },
      notes: STR,
      when: STR,
      deadline: STR,
      tags: STR_ARR,
      checklist_items: STR_ARR,
      heading: {
        ...STR,
        description:
          "Title of a heading defined elsewhere in this items array. Or nest the todo inside the heading's own `items` shorthand instead.",
      },
    },
    required: ["type", "title"],
    additionalProperties: false,
  } as const;

  const projectItemHeadingSchema = {
    type: "object",
    properties: {
      type: { const: "heading" },
      title: { ...STR, description: "Heading title" },
      items: {
        type: "array",
        description:
          "Todos to nest under this heading (shorthand — equivalent to setting `heading: <this title>` on each).",
        items: {
          type: "object",
          properties: {
            title: STR,
            notes: STR,
            when: STR,
            deadline: STR,
            tags: STR_ARR,
            checklist_items: STR_ARR,
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
    },
    required: ["type", "title"],
    additionalProperties: false,
  } as const;

  function toJsonChecklist(
    titles: string[] | undefined,
  ): JsonTodoAttributes["checklist-items"] {
    if (!titles || titles.length === 0) return undefined;
    return titles.map((title) => ({
      type: "checklist-item" as const,
      attributes: { title },
    }));
  }

  function buildProjectChildItems(rawItems: unknown): JsonItem[] {
    if (!Array.isArray(rawItems)) return [];
    const out: JsonItem[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      const raw = rawItems[i];
      if (typeof raw !== "object" || raw === null)
        throw new Error(`items[${i}] must be an object`);
      const r = raw as Args;
      const t = optString(r, "type");
      if (t === "heading") {
        const title = reqString(r, "title");
        out.push({ type: "heading", attributes: { title } });
        // Shorthand: any nested `items` get flattened as todos with this heading.
        const nested = r.items;
        if (Array.isArray(nested)) {
          for (let j = 0; j < nested.length; j++) {
            const n = nested[j];
            if (typeof n !== "object" || n === null)
              throw new Error(`items[${i}].items[${j}] must be an object`);
            const nr = n as Args;
            const ntitle = reqString(nr, "title");
            const checklist = toJsonChecklist(
              optStringArray(nr, "checklist_items"),
            );
            out.push({
              type: "to-do",
              operation: "create",
              attributes: {
                title: ntitle,
                notes: optString(nr, "notes"),
                when: optString(nr, "when"),
                deadline: optString(nr, "deadline"),
                tags: optStringArray(nr, "tags"),
                ...(checklist ? { "checklist-items": checklist } : {}),
                heading: title,
              },
            });
          }
        }
      } else if (t === "to-do") {
        const title = reqString(r, "title");
        const checklist = toJsonChecklist(optStringArray(r, "checklist_items"));
        out.push({
          type: "to-do",
          operation: "create",
          attributes: {
            title,
            notes: optString(r, "notes"),
            when: optString(r, "when"),
            deadline: optString(r, "deadline"),
            tags: optStringArray(r, "tags"),
            ...(checklist ? { "checklist-items": checklist } : {}),
            heading: optString(r, "heading"),
          },
        });
      } else {
        throw new Error(
          `items[${i}].type must be "to-do" or "heading" (got ${JSON.stringify(t)})`,
        );
      }
    }
    return out;
  }

  tools.push({
    name: "add_project",
    description:
      "Create a new project, optionally with structured headings + todos nested under each. `area_id` (from `get_areas`) is preferred over `area_title`. `items` accepts a mix of `{type:'to-do', title, ...}` and `{type:'heading', title, items: [...todos]}` — the heading's nested items are a shorthand for setting `heading: <title>` on each todo.",
    inputSchema: {
      type: "object",
      properties: {
        title: { ...STR, description: "Project title" },
        notes: STR,
        when: {
          ...STR,
          description:
            "Schedule (today/tomorrow/evening/anytime/someday/YYYY-MM-DD)",
        },
        deadline: { ...STR, description: "Deadline (YYYY-MM-DD)" },
        tags: { ...STR_ARR, description: "Tag names" },
        area_id: { ...STR, description: "Area UUID (preferred)" },
        area_title: { ...STR, description: "Area title (fallback)" },
        items: {
          type: "array",
          description: "Mixed todos and headings to seed the project with.",
          items: { oneOf: [projectItemTodoSchema, projectItemHeadingSchema] },
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    outputSchema: ADD_PROJECT_OUTPUT,
    annotations: CREATE,
    handler: (a) => {
      const title = reqString(a, "title");
      const projectAttrs: JsonProjectAttributes = {
        title,
        notes: optString(a, "notes"),
        when: optString(a, "when"),
        deadline: optString(a, "deadline"),
        tags: optStringArray(a, "tags"),
        "area-id": optString(a, "area_id"),
        area: optString(a, "area_title"),
      };
      const children = buildProjectChildItems(a.items);
      if (children.length > 0) projectAttrs.items = children;
      const item: JsonItem = {
        type: "project",
        operation: "create",
        attributes: projectAttrs,
      };
      const urls = chunkedJsonUrls([item]);
      for (const url of urls) executeUrl(url);
      clearSomedayCache();
      return {
        text: `Created new project: ${title}${children.length > 0 ? ` (with ${children.length} item${children.length === 1 ? "" : "s"})` : ""}`,
        structured: { title, items: children.length },
      };
    },
  });

  // Adding a heading to an EXISTING project is not supported — the Things
  // URL scheme silently drops `items` on `operation: update` for projects,
  // and rejects top-level heading objects with any project-reference param
  // we tried (list-id, project, list). Empirically verified. The only path
  // to creating headings is `add_project` with structured `items` at
  // creation time, so no `add_heading` tool ships.

  const todoUpdateSpecSchema = {
    type: "object",
    properties: {
      id: { ...STR, description: "UUID of the todo to update (from any read tool's output)" },
      title: STR,
      notes: STR,
      when: STR,
      deadline: STR,
      tags: { ...STR_ARR, description: "Replaces existing tags" },
      checklist_items: STR_ARR,
      completed: BOOL,
      canceled: BOOL,
      list: { ...STR, description: "Project/area title to move into" },
      list_id: { ...STR, description: "Project/area UUID to move into (preferred)" },
      heading: STR,
      heading_id: STR,
    },
    required: ["id"],
    additionalProperties: false,
  };

  tools.push({
    name: "update_todos",
    description:
      "Update one or more existing todos in a single Things URL call. Each entry must include its `id` (UUID from any read tool); other fields overwrite existing values. Pass an array; size 1 is fine.",
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          minItems: 1,
          description:
            "Array of update specs. Each {id, ...changes}. Pass [{id, completed:true}] for a single update.",
          items: todoUpdateSpecSchema,
        },
      },
      required: ["updates"],
      additionalProperties: false,
    },
    outputSchema: UPDATE_TODOS_OUTPUT,
    annotations: UPDATE,
    handler: async (a, ctx) => {
      const token = requireAuth();
      const updates = a.updates;
      if (!Array.isArray(updates) || updates.length === 0)
        throw new Error("`updates` must be a non-empty array");
      const items: JsonItem[] = updates.map((raw, i) => {
        if (typeof raw !== "object" || raw === null)
          throw new Error(`updates[${i}] must be an object`);
        const r = raw as Args;
        const id = reqString(r, "id");
        const checklist = toJsonChecklist(optStringArray(r, "checklist_items"));
        return {
          type: "to-do" as const,
          operation: "update" as const,
          id,
          attributes: {
            title: optString(r, "title"),
            notes: optString(r, "notes"),
            when: optString(r, "when"),
            deadline: optString(r, "deadline"),
            tags: optStringArray(r, "tags"),
            ...(checklist ? { "checklist-items": checklist } : {}),
            completed: optBool(r, "completed"),
            canceled: optBool(r, "canceled"),
            list: optString(r, "list"),
            "list-id": optString(r, "list_id"),
            heading: optString(r, "heading"),
            "heading-id": optString(r, "heading_id"),
          },
        };
      });
      const closing = (updates as Args[])
        .filter((r) => optBool(r, "completed") === true || optBool(r, "canceled") === true)
        .map((r) => reqString(r, "id"));
      if (closing.length >= CONFIRM_BULK_CLOSE_AT) {
        const titles = closing
          .slice(0, 10)
          .map((id) => `- ${db.getTaskByUuid(id)?.title ?? id}`);
        const more = closing.length > 10 ? `\n…and ${closing.length - 10} more` : "";
        const ok = await ctx.confirm(
          `Complete or cancel ${closing.length} todos in Things?\n${titles.join("\n")}${more}`,
        );
        if (!ok) {
          return {
            text: `Not applied: the user declined completing or canceling ${closing.length} todos. Nothing changed.`,
            structured: { applied: false, updated: 0, batches: 0 },
          };
        }
      }
      const urls = chunkedJsonUrls(items, token);
      for (const url of urls) executeUrl(url);
      clearSomedayCache();
      const n = updates.length;
      return {
        text: `Updated ${n} todo${n === 1 ? "" : "s"}${urls.length > 1 ? ` (in ${urls.length} batches due to URL length)` : ""}`,
        structured: { applied: true, updated: n, batches: urls.length },
      };
    },
  });

  tools.push({
    name: "update_project",
    description:
      "Update an existing project. The `id` is the UUID returned by `get_projects` or any read that surfaces the project.",
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
    outputSchema: UPDATE_PROJECT_OUTPUT,
    annotations: UPDATE,
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
      return { text: `Updated project with ID: ${id}`, structured: { id } };
    },
  });

  return tools;
}
