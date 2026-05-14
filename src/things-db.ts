import { Database } from "bun:sqlite";
import { globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Area,
  ChecklistItem,
  StartBucket,
  Tag,
  Task,
  TaskStatus,
  TaskType,
} from "./types.ts";

// SQL queries below are ported from things.py (MIT-licensed)
// https://github.com/thingsapi/things.py/blob/main/things/database.py

const DB_GLOB =
  "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite";
// things.py threshold; anything below means a pre-3.15.16 schema we don't support.
const MIN_SUPPORTED_DB_VERSION = 22;

const START_TO_FILTER: Record<StartBucket, string> = {
  Inbox: "start = 0",
  Anytime: "start = 1",
  Someday: "start = 2",
};

const STATUS_TO_FILTER: Record<TaskStatus, string> = {
  incomplete: "status = 0",
  canceled: "status = 2",
  completed: "status = 3",
};

const TYPE_TO_FILTER: Record<TaskType, string> = {
  "to-do": "type = 0",
  project: "type = 1",
  heading: "type = 2",
};

const IS_TODO = TYPE_TO_FILTER["to-do"];
const IS_PROJECT = TYPE_TO_FILTER.project;
const IS_HEADING = TYPE_TO_FILTER.heading;
const IS_INCOMPLETE = STATUS_TO_FILTER.incomplete;
const IS_CANCELED = STATUS_TO_FILTER.canceled;
const IS_COMPLETED = STATUS_TO_FILTER.completed;
const IS_INBOX = START_TO_FILTER.Inbox;
const IS_ANYTIME = START_TO_FILTER.Anytime;
const IS_SOMEDAY = START_TO_FILTER.Someday;
const IS_NOT_RECURRING = "rt1_recurrenceRule IS NULL";
const IS_TRASHED = "trashed = 1";

// Things stores dates as binary-packed integers (YYYYYYYYYYYMMMMDDDDD0000000).
const Y_MASK = 0b111111111110000000000000000;
const M_MASK = 0b000000000001111000000000000;
const D_MASK = 0b000000000000000111110000000;

const thingsDateToIsoSql = (col: string): string =>
  `CASE WHEN ${col} THEN printf('%d-%02d-%02d', (${col} & ${Y_MASK}) >> 16, (${col} & ${M_MASK}) >> 12, (${col} & ${D_MASK}) >> 7) ELSE ${col} END`;

const H_MASK = 0b1111100000000000000000000000000;
const TIME_M_MASK = 0b0000011111100000000000000000000;
const thingsTimeToIsoSql = (col: string): string =>
  `CASE WHEN ${col} THEN printf('%02d:%02d', (${col} & ${H_MASK}) >> 26, (${col} & ${TIME_M_MASK}) >> 20) ELSE ${col} END`;

const isoDateToThingsInt = (iso: string): number => {
  const [year, month, day] = iso.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return (year << 16) | (month << 12) | (day << 7);
};

const DATE_OFFSET_RE = /^(\d+)([dwy])$/;
const ISO_DATE_RE = /^(=|==|<|<=|>|>=)?(\d{4}-\d{2}-\d{2})$/;
const TODAY_THINGSDATE_SQL =
  "((strftime('%Y', date('now', 'localtime')) << 16) | (strftime('%m', date('now', 'localtime')) << 12) | (strftime('%d', date('now', 'localtime')) << 7))";

function escapeString(s: string): string {
  return s.replace(/'/g, "''");
}

function findDatabasePath(): string {
  const home = homedir();
  const matches = globSync(DB_GLOB, { cwd: home });
  if (matches.length === 0) {
    throw new Error(
      `Things database not found. Looked under ~/${DB_GLOB}. Is Things 3 installed?`,
    );
  }
  return join(home, matches[0]!);
}

// --- Filter builders ---

function makeFilter(column: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value === false) return `AND ${column} IS NULL`;
  if (value === true) return `AND ${column} IS NOT NULL`;
  return `AND ${column} = '${escapeString(String(value))}'`;
}

function makeOrFilter(...filters: string[]): string {
  const cleaned = filters
    .filter((f) => f.length > 0)
    .map((f) => f.replace(/^AND /, ""));
  if (cleaned.length === 0) return "";
  return `AND (${cleaned.join(" OR ")})`;
}

function makeTruthyFilter(column: string, value: boolean | null): string {
  if (value === null) return "";
  return value ? `AND ${column}` : `AND NOT IFNULL(${column}, 0)`;
}

function makeThingsDateFilter(
  column: string,
  value: string | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return makeFilter(column, value);

  const match = ISO_DATE_RE.exec(value);
  if (match) {
    const comparator = match[1] || "==";
    const isoDate = match[2]!;
    return `AND ${column} ${comparator} ${isoDateToThingsInt(isoDate)}`;
  }
  if (value === "future") return `AND ${column} > ${TODAY_THINGSDATE_SQL}`;
  if (value === "past") return `AND ${column} <= ${TODAY_THINGSDATE_SQL}`;
  throw new Error(`Invalid date value: ${value}`);
}

function makeUnixTimeFilter(
  column: string,
  value: string | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return makeFilter(column, value);

  const match = ISO_DATE_RE.exec(value);
  if (match) {
    const comparator = match[1] || "==";
    const isoDate = match[2]!;
    return `AND date(${column}, 'unixepoch', 'localtime') ${comparator} date('${isoDate}')`;
  }
  const date = `date(${column}, 'unixepoch', 'localtime')`;
  if (value === "future") return `AND ${date} > date('now', 'localtime')`;
  if (value === "past") return `AND ${date} <= date('now', 'localtime')`;
  throw new Error(`Invalid date value: ${value}`);
}

function makeUnixTimeRangeFilter(
  column: string,
  offset: string | null | undefined,
): string {
  if (!offset) return "";
  const match = DATE_OFFSET_RE.exec(offset);
  if (!match) {
    throw new Error(
      `Invalid offset: ${offset}. Use 'Nd', 'Nw', or 'Ny' (e.g., '3d').`,
    );
  }
  const number = Number(match[1]);
  const suffix = match[2]!;
  let modifier: string;
  if (suffix === "d") modifier = `-${number} days`;
  else if (suffix === "w") modifier = `-${number * 7} days`;
  else modifier = `-${number} years`;
  return `AND datetime(${column}, 'unixepoch', 'localtime') > datetime('now', '${modifier}')`;
}

function makeSearchFilter(query: string | null | undefined): string {
  if (!query) return "";
  const q = escapeString(query);
  return `AND (TASK.title LIKE '%${q}%' OR TASK.notes LIKE '%${q}%' OR AREA.title LIKE '%${q}%')`;
}

// --- Core task query ---

function makeTasksSqlQuery(
  wherePredicate: string,
  orderPredicate: string,
): string {
  const startDateExpr = thingsDateToIsoSql("TASK.startDate");
  const deadlineExpr = thingsDateToIsoSql("TASK.deadline");
  const reminderExpr = thingsTimeToIsoSql("TASK.reminderTime");

  return `
    SELECT DISTINCT
      TASK.uuid,
      CASE
        WHEN TASK.${IS_TODO} THEN 'to-do'
        WHEN TASK.${IS_PROJECT} THEN 'project'
        WHEN TASK.${IS_HEADING} THEN 'heading'
      END AS type,
      CASE WHEN TASK.${IS_TRASHED} THEN 1 END AS trashed,
      TASK.title,
      CASE
        WHEN TASK.${IS_INCOMPLETE} THEN 'incomplete'
        WHEN TASK.${IS_CANCELED} THEN 'canceled'
        WHEN TASK.${IS_COMPLETED} THEN 'completed'
      END AS status,
      CASE WHEN AREA.uuid IS NOT NULL THEN AREA.uuid END AS area,
      CASE WHEN AREA.uuid IS NOT NULL THEN AREA.title END AS area_title,
      CASE WHEN PROJECT.uuid IS NOT NULL THEN PROJECT.uuid END AS project,
      CASE WHEN PROJECT.uuid IS NOT NULL THEN PROJECT.title END AS project_title,
      CASE WHEN HEADING.uuid IS NOT NULL THEN HEADING.uuid END AS heading,
      CASE WHEN HEADING.uuid IS NOT NULL THEN HEADING.title END AS heading_title,
      CASE WHEN PROJECT_OF_HEADING.uuid IS NOT NULL THEN PROJECT_OF_HEADING.uuid END AS project_of_heading,
      CASE WHEN PROJECT_OF_HEADING.uuid IS NOT NULL THEN PROJECT_OF_HEADING.title END AS project_of_heading_title,
      CASE
        WHEN PROJECT.${IS_INBOX} THEN 'Inbox'
        WHEN PROJECT.${IS_ANYTIME} THEN 'Anytime'
        WHEN PROJECT.${IS_SOMEDAY} THEN 'Someday'
      END AS project_start,
      CASE
        WHEN PROJECT_OF_HEADING.${IS_INBOX} THEN 'Inbox'
        WHEN PROJECT_OF_HEADING.${IS_ANYTIME} THEN 'Anytime'
        WHEN PROJECT_OF_HEADING.${IS_SOMEDAY} THEN 'Someday'
      END AS project_of_heading_start,
      TASK.notes,
      CASE WHEN TAG.uuid IS NOT NULL THEN 1 END AS tags,
      CASE
        WHEN TASK.${IS_INBOX} THEN 'Inbox'
        WHEN TASK.${IS_ANYTIME} THEN 'Anytime'
        WHEN TASK.${IS_SOMEDAY} THEN 'Someday'
      END AS start,
      CASE WHEN CHECKLIST_ITEM.uuid IS NOT NULL THEN 1 END AS checklist,
      ${startDateExpr} AS start_date,
      ${deadlineExpr} AS deadline,
      ${reminderExpr} AS reminder_time,
      datetime(TASK.stopDate, 'unixepoch', 'localtime') AS stop_date,
      datetime(TASK.creationDate, 'unixepoch', 'localtime') AS created,
      datetime(TASK.userModificationDate, 'unixepoch', 'localtime') AS modified,
      TASK."index" AS "index",
      TASK.todayIndex AS today_index
    FROM TMTask AS TASK
    LEFT OUTER JOIN TMTask PROJECT ON TASK.project = PROJECT.uuid
    LEFT OUTER JOIN TMArea AREA ON TASK.area = AREA.uuid
    LEFT OUTER JOIN TMTask HEADING ON TASK.heading = HEADING.uuid
    LEFT OUTER JOIN TMTask PROJECT_OF_HEADING ON HEADING.project = PROJECT_OF_HEADING.uuid
    LEFT OUTER JOIN TMTaskTag TAGS ON TASK.uuid = TAGS.tasks
    LEFT OUTER JOIN TMTag TAG ON TAGS.tags = TAG.uuid
    LEFT OUTER JOIN TMChecklistItem CHECKLIST_ITEM ON TASK.uuid = CHECKLIST_ITEM.task
    WHERE ${wherePredicate}
    ORDER BY ${orderPredicate}
  `;
}

// --- Public API ---

export interface TaskQuery {
  uuid?: string;
  type?: TaskType;
  status?: TaskStatus | null;
  start?: StartBucket;
  area?: string | boolean;
  project?: string | boolean;
  heading?: string;
  tag?: string;
  start_date?: string | boolean;
  stop_date?: string | boolean;
  deadline?: string | boolean;
  deadline_suppressed?: boolean | null;
  trashed?: boolean | null;
  context_trashed?: boolean | null;
  last?: string;
  search_query?: string;
  index?: "index" | "todayIndex";
}

export class ThingsDB {
  private db: Database;
  private cachedToken: string | null | undefined = undefined;
  private cachedGroupTodayByParent: boolean | undefined = undefined;

  constructor(filepath?: string) {
    const path = filepath ?? findDatabasePath();
    this.db = new Database(path, { readonly: true });
    this.assertSchemaVersion();
  }

  private assertSchemaVersion(): void {
    const row = this.db
      .query("SELECT value FROM Meta WHERE key = 'databaseVersion'")
      .get() as { value: string } | undefined;
    if (!row) {
      throw new Error(
        "Things database has no databaseVersion row. Is this a Things 3 database?",
      );
    }
    // Things stores the version as an XML plist `<integer>N</integer>`.
    const match = /<integer>(\d+)<\/integer>/.exec(row.value);
    const version = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(version) || version < MIN_SUPPORTED_DB_VERSION) {
      throw new Error(
        `Unsupported Things database version: ${row.value}. Need ≥ ${MIN_SUPPORTED_DB_VERSION}.`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  getTasks(q: TaskQuery = {}): Task[] {
    const status = q.status === null ? null : (q.status ?? "incomplete");
    const trashed = q.trashed === undefined ? false : q.trashed;

    const startFilter = q.start ? `AND TASK.${START_TO_FILTER[q.start]}` : "";
    const statusFilter = status ? `AND TASK.${STATUS_TO_FILTER[status]}` : "";
    const trashedFilter =
      trashed === null
        ? ""
        : trashed
          ? `AND TASK.${IS_TRASHED}`
          : "AND TASK.trashed = 0";
    const typeFilter = q.type ? `AND TASK.${TYPE_TO_FILTER[q.type]}` : "";

    const projectTrashed = makeTruthyFilter(
      "PROJECT.trashed",
      q.context_trashed ?? false,
    );
    const projectOfHeadingTrashed = makeTruthyFilter(
      "PROJECT_OF_HEADING.trashed",
      q.context_trashed ?? false,
    );
    const projectFilter = makeOrFilter(
      makeFilter("TASK.project", q.project),
      makeFilter("PROJECT_OF_HEADING.uuid", q.project),
    );

    const where = `
      TASK.${IS_NOT_RECURRING}
      ${trashedFilter}
      ${projectTrashed}
      ${projectOfHeadingTrashed}
      ${typeFilter}
      ${startFilter}
      ${statusFilter}
      ${makeFilter("TASK.uuid", q.uuid)}
      ${makeFilter("TASK.area", q.area)}
      ${projectFilter}
      ${makeFilter("TASK.heading", q.heading)}
      ${makeFilter("TASK.deadlineSuppressionDate", q.deadline_suppressed ?? null)}
      ${makeFilter("TAG.title", q.tag)}
      ${makeThingsDateFilter("TASK.startDate", q.start_date)}
      ${makeUnixTimeFilter("TASK.stopDate", q.stop_date)}
      ${makeThingsDateFilter("TASK.deadline", q.deadline)}
      ${makeUnixTimeRangeFilter("TASK.creationDate", q.last)}
      ${makeSearchFilter(q.search_query)}
    `;
    const order = `TASK."${q.index ?? "index"}"`;

    const sql = makeTasksSqlQuery(where, order);
    return this.db.query(sql).all() as Task[];
  }

  getTaskByUuid(uuid: string): Task | null {
    const sql = makeTasksSqlQuery("TASK.uuid = ?", 'TASK."index"');
    const rows = this.db.query(sql).all(uuid) as Task[];
    return rows[0] ?? null;
  }

  getAreas(query?: { uuid?: string; tag?: string }): Area[] {
    const sql = `
      SELECT DISTINCT
        AREA.uuid,
        'area' AS type,
        AREA.title,
        CASE WHEN AREA_TAG.areas IS NOT NULL THEN 1 END AS tags
      FROM TMArea AS AREA
      LEFT OUTER JOIN TMAreaTag AREA_TAG ON AREA_TAG.areas = AREA.uuid
      LEFT OUTER JOIN TMTag TAG ON TAG.uuid = AREA_TAG.tags
      WHERE TRUE
        ${makeFilter("TAG.title", query?.tag)}
        ${makeFilter("AREA.uuid", query?.uuid)}
      ORDER BY AREA."index"
    `;
    return this.db.query(sql).all() as Area[];
  }

  getTags(query?: { title?: string }): Tag[] {
    const sql = `
      SELECT uuid, 'tag' AS type, title, shortcut
      FROM TMTag
      WHERE TRUE ${makeFilter("title", query?.title)}
      ORDER BY "index"
    `;
    return this.db.query(sql).all() as Tag[];
  }

  getTagTitlesOfTask(taskUuid: string): string[] {
    const sql = `
      SELECT TAG.title
      FROM TMTaskTag AS TASK_TAG
      LEFT OUTER JOIN TMTag TAG ON TAG.uuid = TASK_TAG.tags
      WHERE TASK_TAG.tasks = ?
      ORDER BY TAG."index"
    `;
    return (this.db.query(sql).all(taskUuid) as { title: string }[]).map(
      (r) => r.title,
    );
  }

  getTagTitlesOfArea(areaUuid: string): string[] {
    const sql = `
      SELECT AREA.title
      FROM TMAreaTag AS AREA_TAG
      LEFT OUTER JOIN TMTag AREA ON AREA.uuid = AREA_TAG.tags
      WHERE AREA_TAG.areas = ?
      ORDER BY AREA."index"
    `;
    return (this.db.query(sql).all(areaUuid) as { title: string }[]).map(
      (r) => r.title,
    );
  }

  getChecklistItems(todoUuid: string): ChecklistItem[] {
    const sql = `
      SELECT
        CHECKLIST_ITEM.title,
        CASE
          WHEN CHECKLIST_ITEM.${IS_INCOMPLETE} THEN 'incomplete'
          WHEN CHECKLIST_ITEM.${IS_CANCELED} THEN 'canceled'
          WHEN CHECKLIST_ITEM.${IS_COMPLETED} THEN 'completed'
        END AS status,
        date(CHECKLIST_ITEM.stopDate, 'unixepoch', 'localtime') AS stop_date,
        'checklist-item' AS type,
        CHECKLIST_ITEM.uuid,
        datetime(CHECKLIST_ITEM.userModificationDate, 'unixepoch', 'localtime') AS created,
        datetime(CHECKLIST_ITEM.userModificationDate, 'unixepoch', 'localtime') AS modified
      FROM TMChecklistItem AS CHECKLIST_ITEM
      WHERE CHECKLIST_ITEM.task = ?
      ORDER BY CHECKLIST_ITEM."index"
    `;
    return this.db.query(sql).all(todoUuid) as ChecklistItem[];
  }

  getAuthToken(): string | null {
    if (this.cachedToken !== undefined) return this.cachedToken;
    const row = this.db
      .query("SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
      .get() as { uriSchemeAuthenticationToken: string | null } | undefined;
    this.cachedToken = row?.uriSchemeAuthenticationToken ?? null;
    return this.cachedToken;
  }

  // Things has a user-toggleable "Group Today by Project" preference. When on,
  // the Today view shows tasks grouped under their parent project or area
  // instead of a flat list. We mirror that grouping in `today()`.
  getGroupTodayByParent(): boolean {
    if (this.cachedGroupTodayByParent !== undefined)
      return this.cachedGroupTodayByParent;
    const row = this.db
      .query("SELECT groupTodayByParent FROM TMSettings LIMIT 1")
      .get() as { groupTodayByParent: number | null } | undefined;
    this.cachedGroupTodayByParent = row?.groupTodayByParent === 1;
    return this.cachedGroupTodayByParent;
  }

  // --- Hydration ---

  /**
   * Materialize bool flags into actual nested data: tags array, checklist
   * items, project children, heading children. Mirrors things.py `tasks()`
   * post-processing.
   */
  hydrateTasks(tasks: Task[], includeItems: boolean): Task[] {
    for (const task of tasks) {
      if (task.tags) task.tags = this.getTagTitlesOfTask(task.uuid);
      if (!includeItems) continue;
      if (task.type === "to-do") {
        if (task.checklist) task.checklist = this.getChecklistItems(task.uuid);
      } else if (task.type === "project") {
        const children = this.getTasks({
          project: task.uuid,
          context_trashed: null,
        });
        this.hydrateTasks(children, true);
        // to-dos before headings (matches Things UI order)
        children.sort((a, b) => (a.type < b.type ? 1 : a.type > b.type ? -1 : 0));
        task.items = children;
      } else if (task.type === "heading") {
        const children = this.getTasks({
          type: "to-do",
          heading: task.uuid,
          context_trashed: null,
        });
        this.hydrateTasks(children, true);
        task.items = children;
      }
    }
    return tasks;
  }

  // --- High-level list views (mirroring things.py api.py) ---

  inbox(includeItems = true): Task[] {
    return this.hydrateTasks(this.getTasks({ start: "Inbox" }), includeItems);
  }

  today(includeItems = true): Task[] {
    const regular = this.getTasks({
      start_date: true,
      start: "Anytime",
      index: "todayIndex",
    });
    const unconfirmedScheduled = this.getTasks({
      start_date: "past",
      start: "Someday",
      index: "todayIndex",
    });
    const unconfirmedOverdue = this.getTasks({
      start_date: false,
      deadline: "past",
      deadline_suppressed: false,
    });
    const result = [
      ...regular,
      ...unconfirmedScheduled,
      ...unconfirmedOverdue,
    ];
    result.sort((a, b) => {
      const ai = a.today_index ?? Number.MAX_SAFE_INTEGER;
      const bi = b.today_index ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      const ad = a.start_date ?? "";
      const bd = b.start_date ?? "";
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
    const ordered = this.getGroupTodayByParent()
      ? groupTodayByParent(result)
      : result;
    return this.hydrateTasks(ordered, includeItems);
  }

  upcoming(includeItems = true): Task[] {
    return this.hydrateTasks(
      this.getTasks({ start_date: "future", start: "Someday" }),
      includeItems,
    );
  }

  anytime(includeItems = true): Task[] {
    return this.hydrateTasks(this.getTasks({ start: "Anytime" }), includeItems);
  }

  someday(includeItems = true): Task[] {
    return this.hydrateTasks(
      this.getTasks({ start_date: false, start: "Someday" }),
      includeItems,
    );
  }

  logbook(offset = "7d", includeItems = true): Task[] {
    const completed = this.getTasks({ status: "completed", last: offset });
    const canceled = this.getTasks({ status: "canceled", last: offset });
    const all = [...completed, ...canceled];
    all.sort((a, b) => {
      const ad = a.stop_date ?? "";
      const bd = b.stop_date ?? "";
      return ad < bd ? 1 : ad > bd ? -1 : 0;
    });
    return this.hydrateTasks(all, includeItems);
  }

  trash(includeItems = true): Task[] {
    return this.hydrateTasks(
      this.getTasks({ trashed: true, context_trashed: null, status: null }),
      includeItems,
    );
  }

  todos(project?: string, includeItems = true): Task[] {
    return this.hydrateTasks(
      this.getTasks({ type: "to-do", project }),
      includeItems,
    );
  }

  projects(includeItems = false, start?: StartBucket): Task[] {
    return this.hydrateTasks(
      this.getTasks({ type: "project", start }),
      includeItems,
    );
  }

  headings(project?: string): Task[] {
    return this.getTasks({ type: "heading", project });
  }

  search(query: string, includeItems = true): Task[] {
    return this.hydrateTasks(
      this.getTasks({ search_query: query }),
      includeItems,
    );
  }

  last(offset: string, includeItems = true, status?: TaskStatus): Task[] {
    const result = this.getTasks({ last: offset, ...(status ? { status } : {}) });
    result.sort((a, b) => {
      const ad = a.created ?? "";
      const bd = b.created ?? "";
      return ad < bd ? 1 : ad > bd ? -1 : 0;
    });
    return this.hydrateTasks(result, includeItems);
  }

  get(uuid: string, includeItems = true): Task | null {
    const task = this.getTaskByUuid(uuid);
    if (!task) return null;
    this.hydrateTasks([task], includeItems);
    return task;
  }

  taggedItems(tag: string, includeItems = true): Task[] {
    return this.hydrateTasks(
      this.getTasks({ type: "to-do", tag }),
      includeItems,
    );
  }
}

// Re-order tasks to mirror Things' "Group Today by Project" view:
//   1. All tasks with a parent project (direct or via heading) come first
//   2. Then all tasks with an area parent
//   3. Then orphan tasks
//   Groups within each tier are sorted by the MIN `index` of their tasks
//   (matches Things UI empirically). Within-group order is preserved.
function groupTodayByParent(tasks: Task[]): Task[] {
  type Group = { tier: number; uuid: string; minIndex: number; tasks: Task[] };
  const groups = new Map<string, Group>();
  for (const t of tasks) {
    const projectUuid = t.project ?? t.project_of_heading ?? null;
    const tier = projectUuid ? 0 : t.area ? 1 : 2;
    const uuid = projectUuid ?? t.area ?? "";
    const k = `${tier}:${uuid}`;
    const idx = t.index ?? Number.MAX_SAFE_INTEGER;
    const existing = groups.get(k);
    if (existing) {
      existing.tasks.push(t);
      if (idx < existing.minIndex) existing.minIndex = idx;
    } else {
      groups.set(k, { tier, uuid, minIndex: idx, tasks: [t] });
    }
  }
  const sorted = Array.from(groups.values()).sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.minIndex - b.minIndex;
  });
  return sorted.flatMap((g) => g.tasks);
}
