import { spawnSync } from "node:child_process";

type Param = string | number | boolean | string[] | null | undefined;

function encodeParams(params: Record<string, Param>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (raw === null || raw === undefined) continue;
    let value: string;
    if (typeof raw === "boolean") value = raw ? "true" : "false";
    else if (Array.isArray(raw)) value = raw.join(",");
    else value = String(raw);
    parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}

export function buildUrl(
  command: string,
  params: Record<string, Param>,
): string {
  const query = encodeParams(params);
  return query ? `things:///${command}?${query}` : `things:///${command}`;
}

/** Open a Things URL in the background without bringing the app to the front. */
export function executeUrl(url: string): void {
  const result = spawnSync("open", ["-g", url]);
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || "unknown error";
    throw new Error(`Failed to open Things URL (${stderr}): ${url}`);
  }
}

// --- Single-item commands ---

export interface AddTodoParams {
  title: string;
  notes?: string;
  when?: string;
  deadline?: string;
  tags?: string[];
  "checklist-items"?: string[];
  "list-id"?: string;
  list?: string;
  heading?: string;
  "heading-id"?: string;
  completed?: boolean;
}

export function addTodoUrl(p: AddTodoParams): string {
  return buildUrl("add", {
    title: p.title,
    notes: p.notes,
    when: p.when,
    deadline: p.deadline,
    tags: p.tags,
    "checklist-items": p["checklist-items"]?.join("\n"),
    "list-id": p["list-id"],
    list: p.list,
    heading: p.heading,
    "heading-id": p["heading-id"],
    completed: p.completed,
  });
}

export interface AddProjectParams {
  title: string;
  notes?: string;
  when?: string;
  deadline?: string;
  tags?: string[];
  "area-id"?: string;
  area?: string;
  "to-dos"?: string[];
}

export function addProjectUrl(p: AddProjectParams): string {
  return buildUrl("add-project", {
    title: p.title,
    notes: p.notes,
    when: p.when,
    deadline: p.deadline,
    tags: p.tags,
    "area-id": p["area-id"],
    area: p.area,
    "to-dos": p["to-dos"]?.join("\n"),
  });
}

export interface UpdateTodoParams {
  id: string;
  title?: string;
  notes?: string;
  when?: string;
  deadline?: string;
  tags?: string[];
  completed?: boolean;
  canceled?: boolean;
  list?: string;
  "list-id"?: string;
  heading?: string;
  "heading-id"?: string;
}

export function updateTodoUrl(p: UpdateTodoParams, authToken: string): string {
  return buildUrl("update", { ...p, "auth-token": authToken });
}

export interface UpdateProjectParams {
  id: string;
  title?: string;
  notes?: string;
  when?: string;
  deadline?: string;
  tags?: string[];
  completed?: boolean;
  canceled?: boolean;
}

export function updateProjectUrl(
  p: UpdateProjectParams,
  authToken: string,
): string {
  return buildUrl("update-project", { ...p, "auth-token": authToken });
}

export function showUrl(
  id: string,
  query?: string,
  filterTags?: string[],
): string {
  return buildUrl("show", { id, query, filter: filterTags });
}

export function searchUrl(query: string): string {
  return buildUrl("search", { query });
}

// --- Bulk /json command ---

export interface JsonTodoAttributes {
  title?: string;
  notes?: string;
  when?: string;
  deadline?: string;
  tags?: string[];
  "checklist-items"?: { type: "checklist-item"; attributes: { title: string } }[];
  "list-id"?: string;
  list?: string;
  heading?: string;
  "heading-id"?: string;
  completed?: boolean;
  canceled?: boolean;
  "creation-date"?: string;
  "completion-date"?: string;
}

export interface JsonProjectAttributes
  extends Omit<JsonTodoAttributes, "list" | "list-id" | "heading" | "heading-id"> {
  "area-id"?: string;
  area?: string;
  items?: JsonItem[];
}

export interface JsonHeadingAttributes {
  title: string;
  archived?: boolean;
}

export type JsonItem =
  | {
      type: "to-do";
      operation?: "create" | "update";
      id?: string;
      attributes: JsonTodoAttributes;
    }
  | {
      type: "project";
      operation?: "create" | "update";
      id?: string;
      attributes: JsonProjectAttributes;
    }
  | {
      // Headings live only nested inside a project's `items` array; Things'
      // /json doesn't accept them at the top level. No `operation` or `id` —
      // create-only, addressed by title within the parent project.
      type: "heading";
      attributes: JsonHeadingAttributes;
    };

/**
 * Build a `things:///json?data=[...]` URL. Auth token is required for any
 * update operation; the URL scheme rejects updates without it.
 */
export function jsonUrl(items: JsonItem[], authToken?: string): string {
  const needsAuth = items.some(
    (i) => i.type !== "heading" && i.operation === "update",
  );
  const params: Record<string, Param> = {
    data: JSON.stringify(items),
  };
  if (needsAuth) {
    if (!authToken)
      throw new Error("auth-token required for update operations");
    params["auth-token"] = authToken;
  }
  return buildUrl("json", params);
}

// macOS `open` chokes on extremely long URLs. Empirically a single argv is
// safe up to ~250KB but we leave headroom.
export const MAX_URL_BYTES = 200_000;

/**
 * Split a JSON bulk request into chunks so each resulting URL stays under
 * MAX_URL_BYTES. Returns the constructed URLs in order.
 */
export function chunkedJsonUrls(
  items: JsonItem[],
  authToken?: string,
): string[] {
  const urls: string[] = [];
  let batch: JsonItem[] = [];
  for (const item of items) {
    const next = [...batch, item];
    const url = jsonUrl(next, authToken);
    if (url.length > MAX_URL_BYTES && batch.length > 0) {
      urls.push(jsonUrl(batch, authToken));
      batch = [item];
    } else {
      batch = next;
    }
  }
  if (batch.length > 0) urls.push(jsonUrl(batch, authToken));
  return urls;
}
