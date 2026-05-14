export type TaskType = "to-do" | "project" | "heading";
export type TaskStatus = "incomplete" | "completed" | "canceled";
export type StartBucket = "Inbox" | "Anytime" | "Someday";

export interface Task {
  uuid: string;
  type: TaskType;
  title: string;
  status: TaskStatus;
  notes?: string | null;
  start?: StartBucket | null;
  area?: string | null;
  area_title?: string | null;
  project?: string | null;
  project_title?: string | null;
  heading?: string | null;
  heading_title?: string | null;
  project_of_heading?: string | null;
  project_of_heading_title?: string | null;
  project_start?: StartBucket | null;
  project_of_heading_start?: StartBucket | null;
  start_date?: string | null;
  deadline?: string | null;
  reminder_time?: string | null;
  stop_date?: string | null;
  created?: string | null;
  modified?: string | null;
  index?: number;
  today_index?: number;
  trashed?: boolean | null;
  tags?: string[] | boolean;
  checklist?: ChecklistItem[] | boolean;
  items?: Task[];
}

export interface ChecklistItem {
  uuid: string;
  type: "checklist-item";
  title: string;
  status: TaskStatus;
  stop_date?: string | null;
  created?: string | null;
  modified?: string | null;
}

export interface Area {
  uuid: string;
  type: "area";
  title: string;
  tags?: string[] | boolean;
  items?: Task[];
}

export interface Tag {
  uuid: string;
  type: "tag";
  title: string;
  shortcut?: string | null;
  items?: Task[];
}
