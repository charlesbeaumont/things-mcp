import type { ThingsDB } from "./things-db.ts";
import { effectiveListLabel } from "./formatters.ts";
import type { Area, Tag, Task } from "./types.ts";

type Ref = { uuid: string; title: string } | null;

const NSTR = { type: ["string", "null"] } as const;
const REF_SCHEMA = {
  type: ["object", "null"],
  properties: { uuid: { type: "string" }, title: { type: "string" } },
  required: ["uuid", "title"],
} as const;
const REF_LIST_SCHEMA = { type: "array", items: REF_SCHEMA } as const;

const TODO_SCHEMA = {
  type: "object",
  properties: {
    uuid: { type: "string" },
    type: { enum: ["to-do", "project", "heading"] },
    title: { type: "string" },
    status: { enum: ["incomplete", "completed", "canceled"] },
    list: { ...NSTR, description: "Bucket the Things UI shows: Inbox, Today, Upcoming, Anytime or Someday" },
    list_inherited: { type: "boolean", description: "True when the list comes from a Someday parent project" },
    start_date: NSTR,
    deadline: NSTR,
    reminder_time: NSTR,
    completed_at: NSTR,
    created: NSTR,
    modified: NSTR,
    notes: NSTR,
    project: REF_SCHEMA,
    heading: REF_SCHEMA,
    area: REF_SCHEMA,
    tags: { type: "array", items: { type: "string" } },
    checklist: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, status: { type: "string" } },
        required: ["title", "status"],
      },
    },
  },
  required: ["uuid", "type", "title", "status", "tags", "checklist"],
} as const;

function ref(uuid: string | null | undefined, title: string | null | undefined): Ref {
  return uuid ? { uuid, title: title ?? "" } : null;
}

function refs(tasks: Task[]): Ref[] {
  return tasks.map((t) => ({ uuid: t.uuid, title: t.title }));
}

export function todoJson(t: Task) {
  const eff = effectiveListLabel(t);
  return {
    uuid: t.uuid,
    type: t.type,
    title: t.title,
    status: t.status,
    list: eff?.label ?? null,
    list_inherited: eff?.inherited ?? false,
    start_date: t.start_date ?? null,
    deadline: t.deadline ?? null,
    reminder_time: t.reminder_time ?? null,
    completed_at: t.stop_date ?? null,
    created: t.created ?? null,
    modified: t.modified ?? null,
    notes: t.notes || null,
    project:
      ref(t.project, t.project_title) ?? ref(t.project_of_heading, t.project_of_heading_title),
    heading: ref(t.heading, t.heading_title),
    area: ref(t.area, t.area_title),
    tags: Array.isArray(t.tags) ? t.tags : [],
    checklist: Array.isArray(t.checklist)
      ? t.checklist.map((c) => ({ title: c.title, status: c.status }))
      : [],
  };
}

export function projectJson(db: ThingsDB, p: Task, includeItems: boolean) {
  return {
    uuid: p.uuid,
    title: p.title,
    status: p.status,
    area: ref(p.area, p.area_title),
    start_date: p.start_date ?? null,
    deadline: p.deadline ?? null,
    created: p.created ?? null,
    modified: p.modified ?? null,
    notes: p.notes || null,
    headings: refs(db.headings(p.uuid)),
    ...(includeItems ? { todos: refs(db.todos(p.uuid, false)) } : {}),
  };
}

export function areaJson(db: ThingsDB, a: Area, includeItems: boolean) {
  if (!includeItems) return { uuid: a.uuid, title: a.title };
  const open = (type: "project" | "to-do") =>
    refs(db.getTasks({ type, area: a.uuid }).filter((t) => t.status === "incomplete"));
  return { uuid: a.uuid, title: a.title, projects: open("project"), todos: open("to-do") };
}

export function tagJson(db: ThingsDB, t: Tag, includeItems: boolean) {
  return {
    uuid: t.uuid,
    title: t.title,
    shortcut: t.shortcut ?? null,
    ...(includeItems ? { items: refs(db.taggedItems(t.title, false)) } : {}),
  };
}

export function headingJson(h: Task) {
  return {
    uuid: h.uuid,
    title: h.title,
    project: ref(h.project, h.project_title),
    created: h.created ?? null,
    modified: h.modified ?? null,
    notes: h.notes || null,
  };
}

function listOf(key: string, item: object) {
  return {
    type: "object",
    properties: { [key]: { type: "array", items: item } },
    required: [key],
  };
}

export const TODOS_OUTPUT = listOf("todos", TODO_SCHEMA);

export const PROJECTS_OUTPUT = listOf("projects", {
  type: "object",
  properties: {
    uuid: { type: "string" },
    title: { type: "string" },
    status: { type: "string" },
    area: REF_SCHEMA,
    start_date: NSTR,
    deadline: NSTR,
    created: NSTR,
    modified: NSTR,
    notes: NSTR,
    headings: REF_LIST_SCHEMA,
    todos: { ...REF_LIST_SCHEMA, description: "Present when include_items is true" },
  },
  required: ["uuid", "title", "status", "headings"],
});

export const AREAS_OUTPUT = listOf("areas", {
  type: "object",
  properties: {
    uuid: { type: "string" },
    title: { type: "string" },
    projects: { ...REF_LIST_SCHEMA, description: "Open projects; present when include_items is true" },
    todos: { ...REF_LIST_SCHEMA, description: "Open todos; present when include_items is true" },
  },
  required: ["uuid", "title"],
});

export const TAGS_OUTPUT = listOf("tags", {
  type: "object",
  properties: {
    uuid: { type: "string" },
    title: { type: "string" },
    shortcut: NSTR,
    items: { ...REF_LIST_SCHEMA, description: "Present when include_items is true" },
  },
  required: ["uuid", "title"],
});

export const HEADINGS_OUTPUT = listOf("headings", {
  type: "object",
  properties: {
    uuid: { type: "string" },
    title: { type: "string" },
    project: REF_SCHEMA,
    created: NSTR,
    modified: NSTR,
    notes: NSTR,
  },
  required: ["uuid", "title"],
});

export const ADD_TODOS_OUTPUT = {
  type: "object",
  properties: {
    created: { type: "integer" },
    batches: { type: "integer", description: "URL calls used; more than 1 when the payload hit the length cap" },
  },
  required: ["created", "batches"],
} as const;

export const ADD_PROJECT_OUTPUT = {
  type: "object",
  properties: {
    title: { type: "string" },
    items: { type: "integer", description: "Headings and todos created inside the project" },
  },
  required: ["title", "items"],
} as const;

export const UPDATE_TODOS_OUTPUT = {
  type: "object",
  properties: {
    applied: { type: "boolean", description: "False when the user declined the confirmation" },
    updated: { type: "integer" },
    batches: { type: "integer" },
  },
  required: ["applied", "updated", "batches"],
} as const;

export const UPDATE_PROJECT_OUTPUT = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
} as const;
