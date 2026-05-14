import type { ThingsDB } from "./things-db.ts";
import type { Area, Tag, Task } from "./types.ts";

function calculateAge(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months > 1 ? "s" : ""} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

function safeAreaTitle(db: ThingsDB, areaUuid: string): string | undefined {
  const areas = db.getAreas({ uuid: areaUuid });
  return areas[0]?.title;
}

export function formatTodo(db: ThingsDB, todo: Task): string {
  const lines: string[] = [];
  lines.push(`Title: ${todo.title}`);
  lines.push(`UUID: ${todo.uuid}`);
  lines.push(`Type: ${todo.type}`);
  if (todo.status) lines.push(`Status: ${todo.status}`);

  // Look up parent project (used for both List status and Project display)
  let parentProject: Task | null = null;
  if (todo.project) {
    parentProject = db.get(todo.project, false);
  } else if (todo.heading) {
    const heading = db.get(todo.heading, false);
    if (heading?.project) parentProject = db.get(heading.project, false);
  }

  if (todo.start) {
    let effectiveStart = todo.start as string;
    if (
      effectiveStart !== "Someday" &&
      parentProject &&
      parentProject.start === "Someday"
    ) {
      effectiveStart = "Someday";
      lines.push(`List: ${effectiveStart} (inherited from project)`);
    } else {
      lines.push(`List: ${effectiveStart}`);
    }
  }

  if (todo.start_date) lines.push(`Start Date: ${todo.start_date}`);
  if (todo.deadline) lines.push(`Deadline: ${todo.deadline}`);
  if (todo.stop_date) lines.push(`Completed: ${todo.stop_date}`);

  if (todo.created) {
    lines.push(`Created: ${todo.created}`);
    const age = calculateAge(todo.created);
    if (age) lines.push(`Age: ${age}`);
  }
  if (todo.modified) {
    lines.push(`Modified: ${todo.modified}`);
    const age = calculateAge(todo.modified);
    if (age) lines.push(`Last modified: ${age}`);
  }

  if (todo.notes) lines.push(`Notes: ${todo.notes}`);

  if (parentProject) lines.push(`Project: ${parentProject.title}`);

  if (todo.heading) {
    const heading = db.get(todo.heading, false);
    if (heading) lines.push(`Heading: ${heading.title}`);
  }

  if (todo.area) {
    const title = safeAreaTitle(db, todo.area);
    if (title) lines.push(`Area: ${title}`);
  }

  if (Array.isArray(todo.tags) && todo.tags.length > 0) {
    lines.push(`Tags: ${todo.tags.join(", ")}`);
  }

  if (Array.isArray(todo.checklist) && todo.checklist.length > 0) {
    lines.push("Checklist:");
    for (const item of todo.checklist) {
      const box = item.status === "completed" ? "✓" : "☐";
      lines.push(`  ${box} ${item.title}`);
    }
  }

  return lines.join("\n");
}

export function formatProject(
  db: ThingsDB,
  project: Task,
  includeItems = false,
): string {
  const lines: string[] = [];
  lines.push(`Title: ${project.title}`);
  lines.push(`UUID: ${project.uuid}`);

  if (project.area) {
    const title = safeAreaTitle(db, project.area);
    if (title) lines.push(`Area: ${title}`);
  }

  if (project.notes) lines.push(`Notes: ${project.notes}`);

  if (project.created) {
    lines.push(`Created: ${project.created}`);
    const age = calculateAge(project.created);
    if (age) lines.push(`Age: ${age}`);
  }
  if (project.modified) {
    lines.push(`Modified: ${project.modified}`);
    const age = calculateAge(project.modified);
    if (age) lines.push(`Last modified: ${age}`);
  }

  const headings = db.headings(project.uuid);
  if (headings.length > 0) {
    lines.push("");
    lines.push("Headings:");
    for (const h of headings) lines.push(`- ${h.title}`);
  }

  if (includeItems) {
    const todos = db.todos(project.uuid, false);
    if (todos.length > 0) {
      lines.push("");
      lines.push("Tasks:");
      for (const t of todos) lines.push(`- ${t.title}`);
    }
  }

  return lines.join("\n");
}

export function formatArea(
  db: ThingsDB,
  area: Area,
  includeItems = false,
): string {
  const lines: string[] = [];
  lines.push(`Title: ${area.title}`);
  lines.push(`UUID: ${area.uuid}`);

  if (includeItems) {
    // Projects in this area (uses TaskQuery.area filter on TMTask, type=project)
    const projects = db
      .getTasks({ type: "project", area: area.uuid })
      .filter((p) => p.status === "incomplete");
    if (projects.length > 0) {
      lines.push("");
      lines.push("Projects:");
      for (const p of projects) lines.push(`- ${p.title}`);
    }
    const todos = db
      .getTasks({ type: "to-do", area: area.uuid })
      .filter((t) => t.status === "incomplete");
    if (todos.length > 0) {
      lines.push("");
      lines.push("Tasks:");
      for (const t of todos) lines.push(`- ${t.title}`);
    }
  }

  return lines.join("\n");
}

export function formatTag(
  db: ThingsDB,
  tag: Tag,
  includeItems = false,
): string {
  const lines: string[] = [];
  lines.push(`Title: ${tag.title}`);
  lines.push(`UUID: ${tag.uuid}`);
  if (tag.shortcut) lines.push(`Shortcut: ${tag.shortcut}`);

  if (includeItems) {
    const todos = db.taggedItems(tag.title, false);
    if (todos.length > 0) {
      lines.push("");
      lines.push("Tagged Items:");
      for (const t of todos) lines.push(`- ${t.title}`);
    }
  }

  return lines.join("\n");
}

export function formatHeading(
  db: ThingsDB,
  heading: Task,
  includeItems = false,
): string {
  const lines: string[] = [];
  lines.push(`Title: ${heading.title}`);
  lines.push(`UUID: ${heading.uuid}`);
  lines.push("Type: heading");

  if (heading.project_title) {
    lines.push(`Project: ${heading.project_title}`);
  } else if (heading.project) {
    const project = db.get(heading.project, false);
    if (project) lines.push(`Project: ${project.title}`);
  }

  if (heading.created) {
    lines.push(`Created: ${heading.created}`);
    const age = calculateAge(heading.created);
    if (age) lines.push(`Age: ${age}`);
  }
  if (heading.modified) {
    lines.push(`Modified: ${heading.modified}`);
    const age = calculateAge(heading.modified);
    if (age) lines.push(`Last modified: ${age}`);
  }
  if (heading.notes) lines.push(`Notes: ${heading.notes}`);

  if (includeItems) {
    const todos = db.getTasks({ type: "to-do", heading: heading.uuid });
    if (todos.length > 0) {
      lines.push("");
      lines.push("Tasks under heading:");
      for (const t of todos) lines.push(`- ${t.title}`);
    }
  }

  return lines.join("\n");
}

export function joinFormatted(items: string[]): string {
  if (items.length === 0) return "No items found";
  return items.join("\n\n---\n\n");
}
