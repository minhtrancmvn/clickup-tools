/** Read selected ClickUp task details. */

import {
  BOLD,
  RESET,
  HttpError,
  NetworkError,
  ValueError,
  err,
  errorMessage,
  flagOption,
  formatThousands,
  httpRequest,
  info,
  isDict,
  ok,
  parseCli,
  parseJson,
  print,
  printMissingTokenHelp,
  processOutput,
  pyFloat,
  pyInt,
  pyJsonDumps,
  pyStr,
  pyUnquote,
  pyUrlencode,
  reportHttpError,
  stringOption,
  type CliSpec,
  type Output,
} from "./common.js";
import { getApiToken, getEnvValue } from "./env.js";
import {
  DEFAULT_OUTCOME_FIELD_ID,
  buildTaskUrl,
  isCustomTaskId,
  parseTaskId,
  taskDestination,
  taskQuery,
  type TaskDestination,
} from "./update-task.js";

const TASK_URL_WITH_TEAM_RE = /app\.clickup\.com\/t\/([^/?#]+)\/([^/?#]+)/;
export const DEFAULT_COMMENT_LIMIT = 20;
/** Comments are fetched in pages of COMMENT_PAGE_SIZE, so limits above it cost extra requests. */
export const MAX_COMMENT_LIMIT = 100;
export const COMMENT_PAGE_SIZE = 25;
/** Safety cap on subtask recursion depth to avoid runaway fetches. */
export const MAX_SUBTASK_DEPTH = 10;

type Json = Record<string, unknown>;

/** A ClickUp task comment. */
export interface Comment {
  commentId: string;
  user: string;
  date: string;
  dateMs: number | null;
  text: string;
  resolved: boolean;
  replyCount: number;
  /** Threaded replies, oldest first; only fetched when replies were requested. */
  replies: Comment[];
  repliesNote: string;
}

/** A single ClickUp time tracking entry. */
export interface TimeEntry {
  user: string;
  date: string;
  duration: string;
  startMs: number | null;
  tags: string[];
}

/** A child task of the task being read, with its own nested subtasks. */
export interface Subtask {
  taskId: string;
  customId: string;
  name: string;
  status: string;
  subtasks: Subtask[];
  /** Set when this subtask's own children could not be loaded, so the tree below it is incomplete. */
  subtasksNote: string;
}

/** A task checklist item. */
export interface ChecklistItem {
  itemId: string;
  name: string;
  resolved: boolean;
  parent: string | null;
  children: string[];
}

/** A task checklist with its ordered items. */
export interface Checklist {
  checklistId: string;
  name: string;
  items: ChecklistItem[];
}

/** Selected task fields for display. */
export interface TaskDetails {
  title: string;
  status: string;
  description: string;
  timeEstimate: string;
  timeTracked: string;
  tags: string[];
  outcomeAvailable: boolean;
  outcome: string;
  timeEntries: TimeEntry[];
  timeEntriesNote: string;
  subtasks: Subtask[];
  checklists: Checklist[];
  comments: Comment[];
  commentsIncluded: boolean;
  repliesIncluded: boolean;
  commentsNote: string;
}

export const PROG = "clickup-read-task";

const USAGE = `usage: clickup-read-task [-h] [--task-id ID] [--team-id ID] [--json]
                         [--include-comments] [--include-replies]
                         [--comment-limit COUNT]
                         [TASK_OR_URL]
`;

const HELP = `${USAGE}
Read selected details from a ClickUp task.

positional arguments:
  TASK_OR_URL           ClickUp task ID, custom task ID, or task URL (defaults
                        to CLICKUP_TASK_ID)

options:
  -h, --help            show this help message and exit
  --task-id ID          ClickUp task ID, custom task ID, or task URL
  --team-id ID          ClickUp team/workspace ID for custom task IDs
  --json                Output task details as JSON (AI-ready, omits status
                        lines)
  --include-comments    Include recent task comments
  --include-replies     Include threaded replies under each comment (implies
                        --include-comments)
  --comment-limit COUNT
                        Maximum comments to include (1-${MAX_COMMENT_LIMIT}, default: ${DEFAULT_COMMENT_LIMIT})

examples:
  clickup-read-task --task-id OOLE-523
  clickup-read-task --task-id OOLE-523 --team-id 1234567890
  clickup-read-task https://app.clickup.com/t/1234567890/OOLE-523
  clickup-read-task --task-id OOLE-523 --json
  clickup-read-task --task-id OOLE-523 --include-comments --comment-limit 10
  clickup-read-task --task-id OOLE-523 --json --include-replies

metadata:
  When no task is provided, the task is read from CLICKUP_TASK_ID in .env.

authentication:
  export CLICKUP_API_TOKEN=pk_...
  Custom task IDs also require CLICKUP_TEAM_ID unless the task URL includes it.
`;

export const CLI: CliSpec = {
  prog: PROG,
  usage: USAGE,
  help: HELP,
  maxPositionals: 1,
  options: {
    help: { type: "boolean", short: "h" },
    "task-id": { type: "string" },
    "team-id": { type: "string" },
    json: { type: "boolean" },
    "include-comments": { type: "boolean" },
    "include-replies": { type: "boolean" },
    "comment-limit": { type: "string" },
  },
};

/** Parse a comment count between 1 and MAX_COMMENT_LIMIT; throws ValueError. */
export function parseCommentLimit(value: string): number {
  const limit = /^\s*[+-]?\d+(?:_\d+)*\s*$/.test(value) ? pyInt(value) : null;
  if (limit === null) {
    throw new ValueError("comment limit must be an integer");
  }
  if (limit < 1 || limit > MAX_COMMENT_LIMIT) {
    throw new ValueError(`comment limit must be between 1 and ${MAX_COMMENT_LIMIT}`);
  }
  return limit;
}

export interface ReadTaskArgs {
  task: string;
  taskId: string;
  teamId: string;
  json: boolean;
  includeComments: boolean;
  includeReplies: boolean;
  commentLimit: number;
}

/** Parse CLI arguments. Returns an exit code when help was shown or parsing failed. */
export function parseReadTaskArgs(argv: readonly string[], io: Output = processOutput): ReadTaskArgs | number {
  let commentLimit = DEFAULT_COMMENT_LIMIT;
  const parsed = parseCli(CLI, argv, io, {
    validate: (candidate) => {
      const rawLimit = candidate.values["comment-limit"];
      if (typeof rawLimit !== "string") return null;
      try {
        commentLimit = parseCommentLimit(rawLimit);
        return null;
      } catch (error) {
        return `argument --comment-limit: ${errorMessage(error)}`;
      }
    },
  });
  if (typeof parsed === "number") return parsed;

  return {
    task: parsed.positionals[0] ?? "",
    taskId: stringOption(parsed, "task-id"),
    teamId: stringOption(parsed, "team-id"),
    json: flagOption(parsed, "json"),
    includeComments: flagOption(parsed, "include-comments") || flagOption(parsed, "include-replies"),
    includeReplies: flagOption(parsed, "include-replies"),
    commentLimit,
  };
}

/** Return [taskId, teamId] parsed from an ID string or task URL. */
export function parseTaskIdentifier(value: string): [string, string] {
  const stripped = value.trim();
  const match = TASK_URL_WITH_TEAM_RE.exec(stripped);
  if (match) return [pyUnquote(match[2]!), pyUnquote(match[1]!)];
  return [parseTaskId(stripped), ""];
}

/** Resolve a ClickUp task destination from CLI args and environment. */
export function resolveDestination(taskValue: string, { teamId = "" }: { teamId?: string } = {}): TaskDestination {
  const [resolvedTaskId, urlTeamId] = parseTaskIdentifier(taskValue);
  if (!resolvedTaskId) {
    throw new ValueError("Task ID is required. Pass TASK_OR_URL or --task-id.");
  }

  const customTaskId = isCustomTaskId(resolvedTaskId);
  const resolvedTeamId = teamId.trim() || urlTeamId.trim() || getEnvValue("CLICKUP_TEAM_ID").trim();
  if (customTaskId && !resolvedTeamId) {
    throw new ValueError(
      "CLICKUP_TEAM_ID is required when using a custom task ID. " +
        "Add CLICKUP_TEAM_ID=1234567890 to .env or pass --team-id.",
    );
  }

  return taskDestination(resolvedTaskId, resolvedTeamId, customTaskId);
}

function asDict(value: unknown): Json {
  return isDict(value) ? value : {};
}

/** Extract selected task details from a ClickUp task response. */
export function extractTaskDetails(task: unknown, { outcomeFieldId = "" }: { outcomeFieldId?: string } = {}): TaskDetails {
  const record = asDict(task);
  const [outcomeAvailable, outcome] = extractOutcomeValue(record, { outcomeFieldId });
  return {
    title: stringValue(record.name) || "Untitled",
    status: extractStatus(record),
    description: extractDescription(record),
    timeEstimate: formatDurationMs(record.time_estimate),
    timeTracked: formatDurationMs(record.time_spent),
    tags: extractTags(record),
    outcomeAvailable,
    outcome,
    timeEntries: [],
    timeEntriesNote: "",
    subtasks: extractSubtasks(record),
    checklists: extractChecklists(record),
    comments: [],
    commentsIncluded: false,
    repliesIncluded: false,
    commentsNote: "",
  };
}

/** Extract a task status label. */
export function extractStatus(task: Json): string {
  const status = task.status;
  if (isDict(status)) {
    return stringValue(status.status) || stringValue(status.type) || "Not set";
  }
  return stringValue(status) || "Not set";
}

/** Extract the richest available task description. */
export function extractDescription(task: Json): string {
  for (const key of ["markdown_description", "description", "text_content"]) {
    const value = stringValue(task[key]);
    if (value) return value;
  }
  return "Not set";
}

/** Format a ClickUp millisecond duration for humans. */
export function formatDurationMs(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";

  const milliseconds = pyInt(value);
  if (milliseconds === null) return stringValue(value) || "Not set";

  let seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const remainder = seconds % 3600;
  const minutes = Math.floor(remainder / 60);
  seconds = remainder % 60;

  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds && !hours) parts.push(`${seconds}s`);
  if (!parts.length) parts.push("0m");

  return `${parts.join(" ")} (${formatThousands(milliseconds)} ms)`;
}

/** Extract task tag names. */
export function extractTags(task: Json): string[] {
  return tagNames(task.tags);
}

/** Extract display names from a ClickUp tag list (dicts or strings). */
export function tagNames(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];

  const names: string[] = [];
  for (const tag of tags) {
    const name = isDict(tag) ? stringValue(tag.name) : stringValue(tag);
    if (name) names.push(name);
  }
  return names;
}

async function requestJson(url: string, apiToken: string): Promise<unknown> {
  const body = await httpRequest(url, {
    headers: { Authorization: apiToken, Accept: "application/json" },
    timeoutMs: 15_000,
  });
  return parseJson(body);
}

/**
 * Fetch a ClickUp task including its (direct) subtasks. The description is
 * requested as Markdown: without include_markdown_description ClickUp returns
 * only the flattened plain-text description.
 */
export async function getTaskWithSubtasks(destination: TaskDestination, apiToken: string): Promise<unknown> {
  const params: Record<string, string> = { include_subtasks: "true", include_markdown_description: "true" };
  if (destination.customTaskId) {
    params.custom_task_ids = "true";
    params.team_id = destination.teamId;
  }
  const url = `https://api.clickup.com/api/v2/task/${destination.taskId}?${pyUrlencode(params)}`;
  return requestJson(url, apiToken);
}

/**
 * Fetch the direct subtasks of a task by its internal ID. ClickUp embeds only
 * one level of subtasks per response, so each child is fetched to discover its
 * own children. Internal task IDs do not need custom_task_ids/team_id.
 */
export async function fetchChildSubtasks(taskId: string, apiToken: string): Promise<Json[]> {
  const task = asDict(await requestJson(`https://api.clickup.com/api/v2/task/${taskId}?include_subtasks=true`, apiToken));
  return Array.isArray(task.subtasks) ? task.subtasks.filter(isDict) : [];
}

/** Keep response order unless ClickUp supplies numeric order indexes. */
function orderedRecords(value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  const order = (record: Json): number => {
    const parsed = pyFloat(record.orderindex);
    return parsed === null || Number.isNaN(parsed) ? Infinity : parsed;
  };
  return value.filter(isDict).sort((left, right) => order(left) - order(right));
}

/** Extract checklists and flat parent-linked items from Get Task. */
export function extractChecklists(task: Json): Checklist[] {
  return orderedRecords(task.checklists).map((record) => ({
    checklistId: stringValue(record.id),
    name: stringValue(record.name) || "Untitled",
    items: orderedRecords(record.items).map((item) => ({
      itemId: stringValue(item.id),
      name: stringValue(item.name) || "Untitled",
      resolved: item.resolved === true,
      parent: stringValue(item.parent) || null,
      children: Array.isArray(item.children) ? item.children.map(stringValue).filter(Boolean) : [],
    })),
  }));
}

/** Extract direct child tasks from a ClickUp task response (single level). */
export function extractSubtasks(task: Json): Subtask[] {
  if (!Array.isArray(task.subtasks)) return [];
  return task.subtasks.filter(isDict).map((item) => ({
    taskId: stringValue(item.id),
    customId: stringValue(item.custom_id),
    name: stringValue(item.name) || "Untitled",
    status: extractStatus(item),
    subtasks: [],
    subtasksNote: "",
  }));
}

/**
 * Recursively populate each subtask's own subtasks until the tree is exhausted.
 * A visited set guards against cycles and repeated fetches; maxDepth bounds recursion.
 * A failed child fetch keeps the subtask and records why its children are missing.
 */
export async function expandSubtasks(
  subtasks: Subtask[],
  apiToken: string,
  { maxDepth = MAX_SUBTASK_DEPTH, depth = 1, visited = new Set<string>() }: { maxDepth?: number; depth?: number; visited?: Set<string> } = {},
): Promise<Subtask[]> {
  const expanded: Subtask[] = [];
  for (const subtask of subtasks) {
    let children: Subtask[] = [];
    let subtasksNote = "";
    if (subtask.taskId && !visited.has(subtask.taskId) && depth < maxDepth) {
      visited.add(subtask.taskId);
      let rawChildren: Json[] = [];
      try {
        rawChildren = await fetchChildSubtasks(subtask.taskId, apiToken);
      } catch (error) {
        if (!(error instanceof HttpError || error instanceof NetworkError)) throw error;
        subtasksNote = unavailableNote(error);
      }
      children = await expandSubtasks(extractSubtasks({ subtasks: rawChildren }), apiToken, {
        maxDepth,
        depth: depth + 1,
        visited,
      });
    }
    expanded.push({ ...subtask, subtasks: children, subtasksNote });
  }
  return expanded;
}

/** Whether any subtask in the tree failed to load its children. */
export function subtaskTreeIncomplete(subtasks: Subtask[]): boolean {
  return subtasks.some((subtask) => Boolean(subtask.subtasksNote) || subtaskTreeIncomplete(subtask.subtasks));
}

/**
 * Fetch the newest ClickUp task comments, newest first. ClickUp returns 25 per
 * page; older pages are requested with the last comment's date and id.
 */
export async function getTaskComments(
  destination: TaskDestination,
  apiToken: string,
  { limit = DEFAULT_COMMENT_LIMIT }: { limit?: number } = {},
): Promise<Json[]> {
  const base = `https://api.clickup.com/api/v2/task/${destination.taskId}/comment`;
  const comments: Json[] = [];
  const seen = new Set<string>();
  let cursor: { start: string; startId: string } | null = null;

  while (comments.length < limit) {
    const params: Record<string, string> = {};
    if (destination.customTaskId) {
      params.custom_task_ids = "true";
      params.team_id = destination.teamId;
    }
    if (cursor) {
      params.start = cursor.start;
      params.start_id = cursor.startId;
    }
    const query = Object.keys(params).length ? `?${pyUrlencode(params)}` : "";
    const payload = asDict(await requestJson(`${base}${query}`, apiToken));
    const page = Array.isArray(payload.comments) ? payload.comments.filter(isDict) : [];

    for (const comment of page) {
      const id = stringValue(comment.id);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      comments.push(comment);
    }

    const last = page[page.length - 1];
    if (page.length < COMMENT_PAGE_SIZE || !last) break;
    const next = { start: stringValue(last.date), startId: stringValue(last.id) };
    if (!next.start || !next.startId || (cursor && next.startId === cursor.startId)) break;
    cursor = next;
  }
  return comments.slice(0, limit);
}

/** Fetch the threaded replies of a comment (the parent comment is not included). */
export async function getCommentReplies(commentId: string, apiToken: string): Promise<Json[]> {
  const payload = asDict(await requestJson(`https://api.clickup.com/api/v2/comment/${commentId}/reply`, apiToken));
  return Array.isArray(payload.comments) ? payload.comments.filter(isDict) : [];
}

/** Extract stable, AI-ready fields from ClickUp task comments. */
export function extractComments(records: Json[]): Comment[] {
  return records.map((record) => ({
    commentId: stringValue(record.id),
    user: extractEntryUser(record.user),
    date: formatEpochMs(record.date),
    dateMs: parseEpochMs(record.date),
    text: extractCommentText(record),
    resolved: record.resolved === true,
    replyCount: Math.max(0, pyInt(record.reply_count) ?? 0),
    replies: [],
    repliesNote: "",
  }));
}

/** Attach threaded replies (oldest first) to every comment that has any. */
export async function attachReplies(comments: Comment[], apiToken: string): Promise<Comment[]> {
  const withReplies: Comment[] = [];
  for (const comment of comments) {
    if (!comment.replyCount || !comment.commentId) {
      withReplies.push(comment);
      continue;
    }
    try {
      const replies = extractComments(await getCommentReplies(comment.commentId, apiToken));
      replies.sort((left, right) => (left.dateMs ?? 0) - (right.dateMs ?? 0));
      withReplies.push({ ...comment, replies });
    } catch (error) {
      if (!(error instanceof HttpError || error instanceof NetworkError)) throw error;
      withReplies.push({ ...comment, repliesNote: unavailableNote(error) });
    }
  }
  return withReplies;
}

/** Extract plain comment text, falling back to rich-text fragments. */
export function extractCommentText(record: Json): string {
  const plainText = stringValue(record.comment_text);
  if (plainText) return plainText;

  if (!Array.isArray(record.comment)) return "";
  return record.comment
    .filter(isDict)
    .map((fragment) => (typeof fragment.text === "string" ? fragment.text : stringValue(fragment.text)))
    .join("")
    .trim();
}

/**
 * Fetch ClickUp tracked time for a task (all users, all intervals). Uses the
 * legacy /task/{id}/time endpoint, which has no date window, unlike
 * /team/{id}/time_entries which defaults to the current user and 30 days.
 */
export async function getTimeEntries(destination: TaskDestination, apiToken: string): Promise<Json[]> {
  const url = `https://api.clickup.com/api/v2/task/${destination.taskId}/time${taskQuery(destination)}`;
  const payload = asDict(await requestJson(url, apiToken));
  return Array.isArray(payload.data) ? payload.data.filter(isDict) : [];
}

/** Flatten per-user tracked-time records into interval entries, sorted by start time. */
export function extractTimeEntries(records: Json[]): TimeEntry[] {
  const extracted: TimeEntry[] = [];
  for (const record of records) {
    const user = extractEntryUser(record.user);
    if (!Array.isArray(record.intervals)) continue;
    for (const interval of record.intervals) {
      if (!isDict(interval)) continue;
      extracted.push({
        user,
        date: formatEpochMs(interval.start),
        duration: formatDurationMs(interval.time),
        startMs: parseEpochMs(interval.start),
        tags: tagNames(interval.tags),
      });
    }
  }
  return extracted.sort((left, right) => (left.startMs ?? 0) - (right.startMs ?? 0));
}

/** Extract a display name for a time entry or comment user. */
export function extractEntryUser(user: unknown): string {
  if (isDict(user)) {
    for (const key of ["username", "name", "email"]) {
      const value = stringValue(user[key]);
      if (value) return value;
    }
    const userId = stringValue(user.id);
    if (userId) return `User ${userId}`;
  }
  return "Unknown";
}

/** Parse a ClickUp epoch-millisecond timestamp into an int. */
export function parseEpochMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return pyInt(value);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Format a ClickUp epoch-millisecond timestamp as a UTC date-time. */
export function formatEpochMs(value: unknown): string {
  const milliseconds = parseEpochMs(value);
  const moment = milliseconds === null ? null : new Date(milliseconds);
  if (moment === null || Number.isNaN(moment.getTime())) {
    return stringValue(value) || "Unknown date";
  }
  return (
    `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())} ` +
    `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())} UTC`
  );
}

/** Return [available, value] for the Outcome custom field. */
export function extractOutcomeValue(task: Json, { outcomeFieldId = "" }: { outcomeFieldId?: string } = {}): [boolean, string] {
  if (!Array.isArray(task.custom_fields)) return [false, ""];

  const wantedFieldId =
    outcomeFieldId.trim() || getEnvValue("CLICKUP_OUTCOME_FIELD_ID").trim() || DEFAULT_OUTCOME_FIELD_ID;
  for (const field of task.custom_fields) {
    if (!isDict(field)) continue;
    const fieldId = stringValue(field.id);
    const name = stringValue(field.name);
    if (name.toLowerCase() !== "outcome" && fieldId !== wantedFieldId) continue;

    const value = formatCustomFieldValue(field.value, field);
    return [true, value || "Not set"];
  }
  return [false, ""];
}

/** Format a ClickUp custom field value. */
export function formatCustomFieldValue(value: unknown, field: Json): string {
  if (value === null || value === undefined || value === "") return "";

  const optionNames = optionNameLookup(field);
  if (Array.isArray(value)) {
    return value
      .map((item) => formatCustomFieldItem(item, optionNames))
      .filter(Boolean)
      .join(", ");
  }
  return formatCustomFieldItem(value, optionNames);
}

/** Format one custom field value item. */
export function formatCustomFieldItem(value: unknown, optionNames: Map<string, string>): string {
  if (isDict(value)) {
    for (const key of ["name", "username", "email", "value"]) {
      const nested = stringValue(value[key]);
      if (nested) return nested;
    }
    return pyJsonDumps(value, true);
  }

  const text = stringValue(value);
  return optionNames.get(text) ?? text;
}

/** Build a mapping of ClickUp option IDs/orders to display names. */
export function optionNameLookup(field: Json): Map<string, string> {
  const lookup = new Map<string, string>();
  const typeConfig = field.type_config;
  if (!isDict(typeConfig) || !Array.isArray(typeConfig.options)) return lookup;

  for (const option of typeConfig.options) {
    if (!isDict(option)) continue;
    const name = stringValue(option.name);
    if (!name) continue;
    for (const key of ["id", "orderindex"]) {
      const raw = option[key];
      if (raw !== null && raw !== undefined) lookup.set(pyStr(raw), name);
    }
  }
  return lookup;
}

/** Return a stripped string value when possible. */
export function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return pyStr(value);
  return "";
}

/** Render selected task details as readable text. */
export function renderTaskDetails(details: TaskDetails): string {
  const lines = [
    `Title: ${details.title}`,
    `Status: ${details.status}`,
    "Description:",
    details.description,
    "",
    `Time estimate: ${details.timeEstimate}`,
    `Tracked time: ${details.timeTracked}`,
    `Tags: ${details.tags.length ? details.tags.join(", ") : "None"}`,
  ];
  if (details.outcomeAvailable) {
    lines.push("Outcome:", details.outcome);
  }

  lines.push("Time entries:");
  if (details.timeEntries.length) {
    for (const entry of details.timeEntries) {
      let line = `  - ${entry.date}  ${entry.user}  ${entry.duration}`;
      if (entry.tags.length) line += `  [${entry.tags.join(", ")}]`;
      lines.push(line);
    }
  } else {
    lines.push(`  ${details.timeEntriesNote || "None"}`);
  }

  lines.push(`Subtasks: ${countSubtasks(details.subtasks)}`);
  lines.push(...renderSubtaskLines(details.subtasks));

  lines.push(`Checklists: ${details.checklists.length}`);
  for (const checklist of details.checklists) {
    lines.push(`  ${checklist.name}`);
    lines.push(...renderChecklistItems(checklist.items));
  }

  if (details.commentsIncluded) {
    lines.push(`Comments: ${details.comments.length}`);
    if (details.comments.length) {
      for (const comment of details.comments) {
        const resolved = comment.resolved ? "  [resolved]" : "";
        const replies = comment.replyCount ? `  [${comment.replyCount} ${comment.replyCount === 1 ? "reply" : "replies"}]` : "";
        lines.push(`  - ${comment.date}  ${comment.user}  ${comment.text}${resolved}${replies}`);
        for (const reply of comment.replies) {
          lines.push(`      > ${reply.date}  ${reply.user}  ${reply.text}`);
        }
        if (comment.repliesNote) lines.push(`      > Replies ${comment.repliesNote.toLowerCase()}`);
      }
    } else {
      lines.push(`  ${details.commentsNote || "None"}`);
    }
  }
  return lines.join("\n");
}

/** Render parent-linked items without losing or repeating malformed links. */
export function renderChecklistItems(items: ChecklistItem[]): string[] {
  const byId = new Map(items.filter((item) => item.itemId).map((item) => [item.itemId, item]));
  const rendered = new Set<ChecklistItem>();
  const lines: string[] = [];

  const render = (item: ChecklistItem, depth: number): void => {
    if (rendered.has(item)) return;
    rendered.add(item);
    lines.push(`${"  ".repeat(depth)}[${item.resolved ? "x" : " "}] ${item.name}`);
    for (const child of items) {
      if (child.parent === item.itemId && item.itemId && child !== item) {
        render(child, depth + 1);
      }
    }
  };

  for (const item of items) {
    if (!item.parent || !byId.has(item.parent)) render(item, 2);
  }
  for (const item of items) {
    render(item, 2);
  }
  return lines;
}

/** Count subtasks across the whole nested tree. */
export function countSubtasks(subtasks: Subtask[]): number {
  return subtasks.reduce((total, subtask) => total + 1 + countSubtasks(subtask.subtasks), 0);
}

/** Render the nested subtask tree as indented text lines. */
export function renderSubtaskLines(subtasks: Subtask[], depth = 1): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const subtask of subtasks) {
    const note = subtask.subtasksNote ? `  [subtasks ${subtask.subtasksNote.toLowerCase()}]` : "";
    lines.push(`${indent}- ${subtask.customId || subtask.taskId}  ${subtask.name}  (${subtask.status})${note}`);
    lines.push(...renderSubtaskLines(subtask.subtasks, depth + 1));
  }
  return lines;
}

/** Build an AI-ready, JSON-serialisable mapping of task details. */
export function detailsToDict(details: TaskDetails, { url = "" }: { url?: string } = {}): Json {
  const data: Json = {
    title: details.title,
    status: details.status,
    description: details.description,
    time_estimate: details.timeEstimate,
    tracked_time: details.timeTracked,
    tags: [...details.tags],
    outcome: details.outcomeAvailable ? details.outcome : null,
    checklists: details.checklists.map((checklist) => ({
      id: checklist.checklistId,
      name: checklist.name,
      items: checklist.items.map((item) => ({
        id: item.itemId,
        name: item.name,
        resolved: item.resolved,
        parent: item.parent,
        children: [...item.children],
      })),
    })),
    time_entries: details.timeEntries.map((entry) => ({
      user: entry.user,
      date: entry.date,
      duration: entry.duration,
      start_ms: entry.startMs,
      tags: [...entry.tags],
    })),
  };
  if (!details.timeEntries.length && details.timeEntriesNote) {
    data.time_entries_note = details.timeEntriesNote;
  }
  data.has_subtasks = details.subtasks.length > 0;
  data.subtask_count = countSubtasks(details.subtasks);
  data.subtasks = details.subtasks.map(subtaskToDict);
  if (subtaskTreeIncomplete(details.subtasks)) {
    data.subtasks_incomplete = true;
  }
  if (details.commentsIncluded) {
    data.comments = details.comments.map((comment) => commentToDict(comment, { includeReplies: details.repliesIncluded }));
    if (!details.comments.length && details.commentsNote) {
      data.comments_note = details.commentsNote;
    }
  }
  if (url) data.url = url;
  return data;
}

/** Build a JSON-serialisable mapping for a task comment. */
export function commentToDict(comment: Comment, { includeReplies = false }: { includeReplies?: boolean } = {}): Json {
  const data: Json = {
    id: comment.commentId,
    user: comment.user,
    date: comment.date,
    date_ms: comment.dateMs,
    text: comment.text,
    resolved: comment.resolved,
    reply_count: comment.replyCount,
  };
  if (includeReplies) {
    data.replies = comment.replies.map((reply) => commentToDict(reply));
    if (comment.repliesNote) data.replies_note = comment.repliesNote;
  }
  return data;
}

/** Build a JSON-serialisable mapping for a subtask and its nested subtasks. */
export function subtaskToDict(subtask: Subtask): Json {
  const data: Json = {
    task_id: subtask.taskId,
    custom_id: subtask.customId || null,
    name: subtask.name,
    status: subtask.status,
    subtasks: subtask.subtasks.map(subtaskToDict),
  };
  if (subtask.subtasksNote) data.subtasks_note = subtask.subtasksNote;
  return data;
}

/** Render task details as a JSON document. */
export function renderTaskJson(details: TaskDetails, { url = "" }: { url?: string } = {}): string {
  return JSON.stringify(detailsToDict(details, { url }), null, 2);
}

function unavailableNote(error: unknown): string {
  if (error instanceof HttpError) return `Unavailable (API error ${error.code})`;
  if (error instanceof NetworkError) return `Unavailable (network error: ${error.reason})`;
  return `Unavailable (${errorMessage(error)})`;
}

/** Run the CLI and return a process exit code. */
export async function run(argv: readonly string[], io: Output = processOutput): Promise<number> {
  const args = parseReadTaskArgs(argv, io);
  if (typeof args === "number") return args;

  const taskValue = args.taskId || args.task || getEnvValue("CLICKUP_TASK_ID").trim();
  if (!taskValue) {
    io.stdout(HELP);
    return 0;
  }

  const apiToken = getApiToken();
  if (!apiToken) {
    printMissingTokenHelp(io);
    return 1;
  }

  let destination: TaskDestination;
  try {
    destination = resolveDestination(taskValue, { teamId: args.teamId });
  } catch (error) {
    if (error instanceof ValueError) {
      err(io, error.message);
      return 1;
    }
    throw error;
  }

  if (!args.json) {
    if (destination.customTaskId) {
      info(io, `Target: task=${destination.taskId}  team=${destination.teamId}`);
    } else {
      info(io, `Target: task=${destination.taskId}`);
    }
  }

  let task: unknown;
  try {
    task = await getTaskWithSubtasks(destination, apiToken);
  } catch (error) {
    if (error instanceof HttpError) return reportHttpError(error, io);
    if (error instanceof NetworkError) {
      err(io, `Network error: ${error.reason}`);
      return 1;
    }
    err(io, `Unexpected error: ${errorMessage(error)}`);
    return 1;
  }

  const outcomeFieldId = getEnvValue("CLICKUP_OUTCOME_FIELD_ID").trim() || DEFAULT_OUTCOME_FIELD_ID;
  let details = extractTaskDetails(task, { outcomeFieldId });

  if (details.subtasks.length) {
    try {
      details = { ...details, subtasks: await expandSubtasks(details.subtasks, apiToken) };
    } catch (error) {
      // Keep the direct subtasks already extracted.
      if (!(error instanceof HttpError || error instanceof NetworkError)) throw error;
    }
  }

  try {
    const rawRecords = await getTimeEntries(destination, apiToken);
    details = { ...details, timeEntries: extractTimeEntries(rawRecords) };
  } catch (error) {
    details = { ...details, timeEntriesNote: unavailableNote(error) };
  }

  if (args.includeComments) {
    try {
      const rawComments = await getTaskComments(destination, apiToken, { limit: args.commentLimit });
      let comments = extractComments(rawComments);
      if (args.includeReplies) comments = await attachReplies(comments, apiToken);
      details = { ...details, comments, commentsIncluded: true, repliesIncluded: args.includeReplies };
    } catch (error) {
      details = { ...details, commentsIncluded: true, repliesIncluded: args.includeReplies, commentsNote: unavailableNote(error) };
    }
  }

  const taskUrl = buildTaskUrl(destination.taskId, destination.teamId);
  if (args.json) {
    print(io, renderTaskJson(details, { url: taskUrl }));
  } else {
    print(io, renderTaskDetails(details));
    print(io);
    ok(io, `URL: ${BOLD}${taskUrl}${RESET}`);
  }
  return 0;
}

/** CLI entry point. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await run(argv);
}
