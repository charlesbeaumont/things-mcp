import type { ThingsDB } from "./things-db.ts";
import type { Task } from "./types.ts";

/**
 * Replicate hald's Someday-project filtering. The Things UI hides tasks
 * belonging to a project marked "Someday" from Today/Upcoming/Anytime even
 * when the task itself has start=Anytime. We do the same client-side because
 * the SQLite schema doesn't inherit project Someday status to children.
 */
interface SomedayContext {
  somedayProjectIds: Set<string>;
  headingToProject: Map<string, string>; // heading uuid -> parent project uuid
  expiresAt: number;
}

// Short TTL so edits made directly in the Things app (not via this MCP) get
// picked up within a minute, without paying for the rebuild on every call.
const CACHE_TTL_MS = 60_000;

let cachedContext: SomedayContext | null = null;

export function clearSomedayCache(): void {
  cachedContext = null;
}

function getContext(db: ThingsDB): SomedayContext {
  if (cachedContext && cachedContext.expiresAt > Date.now()) return cachedContext;
  const somedayProjects = db.projects(false, "Someday");
  const somedayProjectIds = new Set(somedayProjects.map((p) => p.uuid));
  const headingToProject = new Map<string, string>();
  for (const projectId of somedayProjectIds) {
    const headings = db.headings(projectId);
    for (const h of headings) headingToProject.set(h.uuid, projectId);
  }
  cachedContext = {
    somedayProjectIds,
    headingToProject,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return cachedContext;
}

export function isInSomedayProject(task: Task, ctx: SomedayContext): boolean {
  if (task.project && ctx.somedayProjectIds.has(task.project)) return true;
  if (!task.project && task.heading && ctx.headingToProject.has(task.heading))
    return true;
  return false;
}

export function filterSomedayProjectTasks(
  db: ThingsDB,
  tasks: Task[],
): Task[] {
  const ctx = getContext(db);
  if (ctx.somedayProjectIds.size === 0) return tasks;
  return tasks.filter((t) => !isInSomedayProject(t, ctx));
}

/**
 * Inverse of the filter: also INCLUDE tasks from Someday projects.
 * Used by `get_someday` to surface anytime-bucketed tasks living inside a
 * Someday project (which the raw `someday()` query misses).
 */
export function expandSomedayWithProjectMembers(
  db: ThingsDB,
  someday: Task[],
  anytime: Task[],
): Task[] {
  const ctx = getContext(db);
  if (ctx.somedayProjectIds.size === 0) return someday;
  const known = new Set(someday.map((t) => t.uuid));
  const extras = anytime.filter(
    (t) => isInSomedayProject(t, ctx) && !known.has(t.uuid),
  );
  return [...someday, ...extras];
}
