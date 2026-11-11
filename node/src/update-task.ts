/** Update a ClickUp task description from a Markdown file. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  BOLD,
  RESET,
  FileNotFoundError,
  HttpError,
  NetworkError,
  ValueError,
  err,
  errorMessage,
  flagOption,
  formatThousands,
  guessMimeType,
  httpRequest,
  info,
  isDict,
  isFile,
  ok,
  parseCli,
  parseJson,
  pathExists,
  print,
  printMissingTokenHelp,
  processOutput,
  pyLen,
  pyInt,
  pyRepr,
  pyResolve,
  pySlice,
  pyUnquote,
  pyUrlencode,
  reportHttpError,
  stringOption,
  type CliSpec,
  type Output,
} from "./common.js";
import { extractChecklistSections, syncChecklists, type MarkdownChecklist } from "./checklists.js";
import { getApiToken, getEnvValue } from "./env.js";
import {
  createLinkContext,
  extractTitle,
  isLocalAssetReference,
  linkifyBareUrls,
  normalizeMarkdownUrl,
  parseFrontMatter,
  readMarkdown,
  resolveAssetPath,
  setFrontMatterValues,
} from "./update-page.js";

const TASK_URL_RE = /app\.clickup\.com\/t\/(?:[^/]+\/)?([^/?#]+)/;
const CUSTOM_TASK_ID_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const MARKDOWN_LINK_OR_IMAGE_SOURCE = String.raw`(!?\[[^\]]*\]\()(<[^>\n]+>|[^)\s\n]+)([^)\n]*\))`;
export const DEFAULT_OUTCOME_FIELD_ID = "8477a7ee-f750-4e8e-8298-0131ef93adab";

/** Resolved destination for a ClickUp task request. */
export interface TaskDestination {
  taskId: string;
  teamId: string;
  customTaskId: boolean;
}

export function taskDestination(taskId: string, teamId = "", customTaskId = false): TaskDestination {
  return { taskId, teamId, customTaskId };
}

/** A local file referenced by Markdown content. */
export interface LocalAttachment {
  target: string;
  path: string;
}

/** Markdown content after ClickUp task-oriented preprocessing. */
export interface PreparedTaskContent {
  content: string;
  attachments: LocalAttachment[];
  /** Resolved local path -> uploaded attachment URL, in upload order. */
  uploadedAttachments: Map<string, string>;
  /** Resolved local path -> URL of an identical file already attached to the task (not re-uploaded). */
  reusedAttachments: Map<string, string>;
  title: string | null;
  outcome: string | null;
  /** Task fields from front matter (status, priority, ...), ready for the Update Task payload. */
  fields: TaskFields;
  /** The front matter values behind `fields`, for display. */
  fieldSources: Record<string, string>;
  /** `## Checklist` sections, removed from `content` and synced as ClickUp checklists. */
  checklists: MarkdownChecklist[];
  normalizedLinks: number;
}

/** Task properties that front matter can set through Update Task. */
export interface TaskFields {
  status?: string;
  priority?: number | null;
  points?: number;
  time_estimate?: number;
  start_date?: number;
  start_date_time?: boolean;
  due_date?: number;
  due_date_time?: boolean;
}

/** Front matter keys that map to task fields, in display order. */
export const TASK_FIELD_KEYS = ["status", "priority", "points", "time_estimate", "start_date", "due_date"] as const;

const PRIORITIES: Record<string, number | null> = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4,
  none: null,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
};

const DURATION_RE = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/i;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Parse "1h 30m", "90m", "1.5h" into milliseconds; throws ValueError. */
export function parseTimeEstimate(value: string): number {
  const match = DURATION_RE.exec(value.trim());
  if (!value.trim() || !match || (match[1] === undefined && match[2] === undefined)) {
    throw new ValueError(`time_estimate must use hours and/or minutes, e.g. "2h", "45m" or "1h 30m"; got ${pyRepr(value)}`);
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  return Math.round((hours * 60 + minutes) * 60_000);
}

/**
 * Parse a front matter date into Unix milliseconds. "YYYY-MM-DD" is a date
 * without a time (local midnight); "YYYY-MM-DD HH:MM" is local time; ISO
 * timestamps with Z or an offset are exact. Throws ValueError.
 */
export function parseTaskDate(key: string, value: string): { ms: number; hasTime: boolean } {
  const text = value.trim();
  const local = (parts: number[], hasTime: boolean) => {
    const [year, month, day, hour = 0, minute = 0, second = 0] = parts as [number, number, number, number?, number?, number?];
    const date = new Date(year, month - 1, day, hour, minute, second);
    const valid =
      date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute;
    return valid ? { ms: date.getTime(), hasTime } : null;
  };

  let parsed: { ms: number; hasTime: boolean } | null = null;
  const dateOnly = DATE_ONLY_RE.exec(text);
  const localTime = LOCAL_DATETIME_RE.exec(text);
  if (dateOnly) {
    parsed = local(dateOnly.slice(1).map(Number), false);
  } else if (localTime) {
    parsed = local(localTime.slice(1).filter((part) => part !== undefined).map(Number), true);
  } else if (ZONED_DATETIME_RE.test(text) && !Number.isNaN(Date.parse(text))) {
    parsed = { ms: Date.parse(text), hasTime: true };
  }
  if (!parsed) {
    throw new ValueError(`${key} must be YYYY-MM-DD, "YYYY-MM-DD HH:MM" or an ISO timestamp; got ${pyRepr(value)}`);
  }
  return parsed;
}

/** Read task fields from front matter; empty values are ignored. Throws ValueError on invalid values. */
export function parseTaskFields(metadata: Record<string, string>): { fields: TaskFields; sources: Record<string, string> } {
  const fields: TaskFields = {};
  const sources: Record<string, string> = {};
  for (const key of TASK_FIELD_KEYS) {
    const raw = (metadata[key] ?? "").trim();
    if (!raw) continue;
    sources[key] = raw;
    switch (key) {
      case "status":
        fields.status = raw;
        break;
      case "priority": {
        const priority = PRIORITIES[raw.toLowerCase()];
        if (priority === undefined) {
          throw new ValueError(`priority must be urgent, high, normal, low, none or 1-4; got ${pyRepr(raw)}`);
        }
        fields.priority = priority;
        break;
      }
      case "points":
        if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new ValueError(`points must be a number; got ${pyRepr(raw)}`);
        fields.points = Number(raw);
        break;
      case "time_estimate":
        fields.time_estimate = parseTimeEstimate(raw);
        break;
      case "start_date":
      case "due_date": {
        const { ms, hasTime } = parseTaskDate(key, raw);
        fields[key] = ms;
        fields[`${key}_time`] = hasTime;
        break;
      }
    }
  }
  return { fields, sources };
}

/** An attachment already on a task, keyed by file name and byte size. */
export function attachmentKey(title: string, size: number | string): string {
  return `${title}\0${size}`;
}

/**
 * Map existing task attachments to their URLs by file name and size. Entries
 * without a size are skipped, so a file is only reused when both match.
 */
export function existingAttachmentUrls(task: unknown): Map<string, string> {
  const urls = new Map<string, string>();
  const attachments = isDict(task) && Array.isArray(task.attachments) ? task.attachments.filter(isDict) : [];
  for (const attachment of attachments) {
    if (attachment.deleted === true) continue;
    const title = typeof attachment.title === "string" ? attachment.title.trim() : "";
    const size = pyInt(attachment.size);
    const url = extractAttachmentUrl(attachment);
    if (title && size !== null && url && !urls.has(attachmentKey(title, size))) {
      urls.set(attachmentKey(title, size), url);
    }
  }
  return urls;
}

export const PROG = "clickup-update-task";

const USAGE = `usage: clickup-update-task [-h] [--task-id ID] [--team-id ID]
                           [--no-rich-links]
                           [FILE]
`;

const HELP = `${USAGE}
Update a ClickUp task description from a markdown file.

positional arguments:
  FILE             Markdown file to upload

options:
  -h, --help       show this help message and exit
  --task-id ID     ClickUp task ID or task URL
  --team-id ID     ClickUp team/workspace ID
  --no-rich-links  Do not rewrite bare ClickUp/Figma URLs into Markdown
                   links/previews

examples:
  clickup-update-task notes.md
  clickup-update-task --task-id OOLE-523 notes.md
  clickup-update-task --task-id OOLE-523 --team-id 1234567890 notes.md
  clickup-update-task notes.md --no-rich-links

metadata:
  When no task ID is provided, the destination is read from front matter:
    ---
    clickup-task-id: OOLE-523
    ---

  For custom task IDs, set CLICKUP_TEAM_ID in .env, or override with:
    clickup-team-id: 1234567890

authentication:
  export CLICKUP_API_TOKEN=pk_...
  https://app.clickup.com/settings/apps
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
    "no-rich-links": { type: "boolean" },
  },
};

/** Parse a ClickUp task ID from an ID string or task URL. */
export function parseTaskId(value: string): string {
  const stripped = value.trim();
  const match = TASK_URL_RE.exec(stripped);
  if (match) return pyUnquote(match[1]!);
  return stripped;
}

/** Return whether a task ID looks like a ClickUp custom task ID. */
export function isCustomTaskId(taskId: string): boolean {
  return CUSTOM_TASK_ID_RE.test(taskId.trim());
}

/** Resolve the task destination from CLI args, metadata, and environment. */
export function resolveDestination(
  markdownFile: string,
  { taskId = "", teamId = "" }: { taskId?: string; teamId?: string } = {},
): TaskDestination {
  let metadata: Record<string, string> = {};
  if (!taskId || !teamId) {
    [metadata] = parseFrontMatter(readMarkdown(markdownFile));
  }

  const resolvedTaskId = parseTaskId(taskId || metadata["clickup-task-id"] || "");
  if (!resolvedTaskId) {
    throw new ValueError(
      `No clickup-task-id metadata found in ${pyRepr(markdownFile)}. ` +
        "Add front matter like: clickup-task-id: OOLE-523",
    );
  }

  const customTaskId = isCustomTaskId(resolvedTaskId);
  const resolvedTeamId =
    teamId.trim() || (metadata["clickup-team-id"] ?? "").trim() || getEnvValue("CLICKUP_TEAM_ID").trim();
  if (customTaskId && !resolvedTeamId) {
    throw new ValueError(
      "CLICKUP_TEAM_ID is required when using a custom task ID. " +
        "Add CLICKUP_TEAM_ID=1234567890 to .env or pass --team-id.",
    );
  }

  return taskDestination(resolvedTaskId, resolvedTeamId, customTaskId);
}

/** Build a browser URL for a ClickUp task. */
export function buildTaskUrl(taskId: string, teamId = ""): string {
  if (teamId) return `https://app.clickup.com/t/${teamId}/${taskId}`;
  return `https://app.clickup.com/t/${taskId}`;
}

/** Build the ClickUp query string for custom task IDs. */
export function taskQuery(destination: TaskDestination): string {
  if (!destination.customTaskId) return "";
  return `?${pyUrlencode({ custom_task_ids: "true", team_id: destination.teamId })}`;
}

function jsonHeaders(apiToken: string, withBody: boolean): Record<string, string> {
  return withBody
    ? { Authorization: apiToken, "Content-Type": "application/json", Accept: "application/json" }
    : { Authorization: apiToken, Accept: "application/json" };
}

/** Fetch a ClickUp task. */
export async function getTask(destination: TaskDestination, apiToken: string): Promise<unknown> {
  const url = `https://api.clickup.com/api/v2/task/${destination.taskId}${taskQuery(destination)}`;
  return parseJson(await httpRequest(url, { headers: jsonHeaders(apiToken, false), timeoutMs: 15_000 }));
}

/** Extract the internal task ID from a ClickUp task response. */
export function extractInternalTaskId(task: unknown, fallback: string): string {
  const value = isDict(task) ? task.id : undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

/** Call the ClickUp API to replace a task description with Markdown content (plus optional task fields). */
export async function updateTaskDescription(
  destination: TaskDestination,
  content: string,
  apiToken: string,
  name: string | null = null,
  fields: TaskFields = {},
): Promise<unknown> {
  const url = `https://api.clickup.com/api/v2/task/${destination.taskId}${taskQuery(destination)}`;
  const payload: Record<string, unknown> = { markdown_content: content, ...fields };
  if (name) payload.name = name;

  const body = await httpRequest(url, {
    method: "PUT",
    headers: jsonHeaders(apiToken, true),
    body: JSON.stringify(payload),
  });
  return body ? parseJson(body) : {};
}

/** Set a single custom field value on a ClickUp task. */
export async function setTaskCustomField(
  destination: TaskDestination,
  fieldId: string,
  value: string,
  apiToken: string,
): Promise<unknown> {
  const url = `https://api.clickup.com/api/v2/task/${destination.taskId}/field/${fieldId}${taskQuery(destination)}`;
  const body = await httpRequest(url, {
    method: "POST",
    headers: jsonHeaders(apiToken, true),
    body: JSON.stringify({ value }),
  });
  return body ? parseJson(body) : {};
}

/** Upload one local file to a ClickUp task and return its public URL. */
export async function uploadTaskAttachment(
  destination: TaskDestination,
  filePath: string,
  apiToken: string,
): Promise<string> {
  const boundary = `----clickup-tools-${randomUUID().replace(/-/g, "")}`;
  const body = buildMultipartBody(filePath, boundary);
  const url = `https://api.clickup.com/api/v2/task/${destination.taskId}/attachment`;
  const response = await httpRequest(url, {
    method: "POST",
    headers: {
      Authorization: apiToken,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Accept: "application/json",
    },
    body,
  });

  const attachmentUrl = extractAttachmentUrl(parseJson(response));
  if (!attachmentUrl) {
    throw new ValueError(`ClickUp did not return an attachment URL for ${filePath}`);
  }
  return attachmentUrl;
}

/** Build a multipart/form-data body for ClickUp attachment upload. */
export function buildMultipartBody(filePath: string, boundary: string): Buffer {
  const filename = path.basename(filePath);
  const header =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="attachment"; filename="${escapeHeaderValue(filename)}"\r\n` +
    `Content-Type: ${guessMimeType(filename)}\r\n` +
    "\r\n";
  const footer = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(header, "utf8"), fs.readFileSync(filePath), Buffer.from(footer, "utf8")]);
}

/** Escape a value used in a multipart header parameter. */
export function escapeHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Extract a usable URL from likely ClickUp attachment response shapes. */
export function extractAttachmentUrl(payload: unknown): string {
  if (!isDict(payload)) return "";

  const candidates: Record<string, unknown>[] = [payload];
  for (const key of ["attachment", "data"]) {
    const nested = payload[key];
    if (isDict(nested)) candidates.push(nested);
  }
  const attachments = payload.attachments;
  if (Array.isArray(attachments)) {
    candidates.push(...attachments.filter(isDict));
  }

  for (const candidate of candidates) {
    for (const key of ["url", "download_url", "attachment_url", "thumb_url"]) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

/** Read Markdown, upload local references, and prepare the task description. */
export async function prepareMarkdownTaskContent(
  markdownPath: string,
  apiToken: string,
  destination: TaskDestination,
  { richLinks = true }: { richLinks?: boolean } = {},
): Promise<PreparedTaskContent> {
  const [metadata, body] = parseFrontMatter(readMarkdown(markdownPath));
  let [title, content] = extractTitle(body);
  // `## Checklist` sections become ClickUp checklists instead of description text.
  const [checklists, withoutChecklists] = extractChecklistSections(content);
  if (checklists.length) {
    const trimmed = withoutChecklists.trimEnd();
    content = trimmed ? `${trimmed}\n` : "";
  }
  const outcome = (metadata.outcome ?? "").trim() || null;
  const { fields, sources: fieldSources } = parseTaskFields(metadata);
  const markdownDir = path.dirname(markdownPath);
  const attachments = findLocalAttachmentReferences(content, markdownDir);

  const missing = attachments.filter((attachment) => !isFile(attachment.path));
  if (missing.length) {
    const missingText = missing.map((item) => `  ${item.target} -> ${item.path}`).join("\n");
    throw new FileNotFoundError(`Referenced attachment file not found:\n${missingText}`);
  }

  const uploaded = new Map<string, string>();
  const reused = new Map<string, string>();
  if (attachments.length) {
    // One Get Task gives both the internal ID (needed for uploads) and the existing attachments.
    const task = await getTask(destination, apiToken);
    const uploadDestination = destination.customTaskId
      ? taskDestination(extractInternalTaskId(task, destination.taskId), destination.teamId, false)
      : destination;
    const existing = existingAttachmentUrls(task);
    for (const attachment of attachments) {
      const resolvedPath = pyResolve(attachment.path);
      if (uploaded.has(resolvedPath) || reused.has(resolvedPath)) continue;
      const existingUrl = existing.get(attachmentKey(path.basename(resolvedPath), fs.statSync(resolvedPath).size));
      if (existingUrl) {
        reused.set(resolvedPath, existingUrl);
      } else {
        uploaded.set(resolvedPath, await uploadTaskAttachment(uploadDestination, resolvedPath, apiToken));
      }
    }
    content = rewriteLocalAttachmentReferences(content, markdownDir, new Map([...reused, ...uploaded]));
  }

  let normalizedLinks = 0;
  if (richLinks) {
    [content, normalizedLinks] = await linkifyBareUrls(content, createLinkContext(apiToken));
  }

  return {
    content,
    attachments,
    uploadedAttachments: uploaded,
    reusedAttachments: reused,
    title,
    outcome,
    fields,
    fieldSources,
    checklists,
    normalizedLinks,
  };
}

/** Where a new task goes: the List from clickup-list, optionally as a subtask of clickup-parent-task. */
export interface CreateTaskTarget {
  listId: string;
  parentTask: string;
}

/** Return the List ID from a numeric ID or a ClickUp List URL; throws ValueError. */
export function parseListId(value: string): string {
  const text = value.trim();
  if (/^\d+$/.test(text)) return text;
  const match = /\/li\/(\d+)/.exec(text) ?? /\/v\/l\/\d+-(\d+)-\d+/.exec(text);
  if (match) return match[1]!;
  throw new ValueError(`Cannot parse ClickUp List: ${pyRepr(value)}\nUse the List ID or a List URL like https://app.clickup.com/<workspace>/v/li/<list_id>`);
}

/** A create target when front matter has clickup-list but no clickup-task-id; otherwise null. */
export function readCreateTaskTarget(filePath: string): CreateTaskTarget | null {
  const [metadata] = parseFrontMatter(readMarkdown(filePath));
  if (metadata["clickup-task-id"] || !metadata["clickup-list"]) return null;
  return { listId: parseListId(metadata["clickup-list"]), parentTask: (metadata["clickup-parent-task"] ?? "").trim() };
}

/**
 * Check everything that would make the follow-up update fail, before a task is
 * created: a `# Name` heading, valid task fields, and existing local files.
 */
export function validateNewTaskFile(filePath: string): string {
  const [metadata, body] = parseFrontMatter(readMarkdown(filePath));
  const [title, content] = extractTitle(body);
  if (!title) throw new ValueError("A new task needs a name: start the Markdown with a `# Task name` heading.");
  parseTaskFields(metadata);
  const missing = findLocalAttachmentReferences(content, path.dirname(filePath)).filter((attachment) => !isFile(attachment.path));
  if (missing.length) {
    const missingText = missing.map((item) => `  ${item.target} -> ${item.path}`).join("\n");
    throw new FileNotFoundError(`Referenced attachment file not found:\n${missingText}`);
  }
  return title;
}

/** Create a task (name only; the normal update fills in the rest) and return the API response. */
export async function createTask(
  listId: string,
  task: { name: string; parent: string | null },
  apiToken: string,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { name: task.name };
  if (task.parent) payload.parent = task.parent;
  const body = await httpRequest(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: "POST",
    headers: jsonHeaders(apiToken, true),
    body: JSON.stringify(payload),
  });
  const created = body ? parseJson(body) : {};
  if (!isDict(created) || typeof created.id !== "string" || !created.id) {
    throw new ValueError("ClickUp did not return the new task ID.");
  }
  return created;
}

/** Resolve clickup-parent-task (ID, custom ID or URL) to the internal task ID Create Task needs. */
export async function resolveParentTask(value: string, teamId: string, apiToken: string): Promise<string> {
  const parentId = parseTaskId(value);
  if (!isCustomTaskId(parentId)) return parentId;
  if (!teamId) {
    throw new ValueError("CLICKUP_TEAM_ID is required when clickup-parent-task is a custom task ID.");
  }
  const parent = await getTask(taskDestination(parentId, teamId, true), apiToken);
  return extractInternalTaskId(parent, parentId);
}

/** Find local Markdown file references to upload as task attachments. */
export function findLocalAttachmentReferences(content: string, markdownDir: string): LocalAttachment[] {
  const refs: LocalAttachment[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(new RegExp(MARKDOWN_LINK_OR_IMAGE_SOURCE, "g"))) {
    const rawTarget = normalizeMarkdownUrl(match[2]!);
    if (!isLocalAssetReference(rawTarget)) continue;

    const assetPath = resolveAssetPath(rawTarget, markdownDir);
    const key = `${rawTarget}\0${pathExists(assetPath) ? pyResolve(assetPath) : assetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ target: rawTarget, path: assetPath });
  }
  return refs;
}

/** Rewrite local Markdown references to uploaded ClickUp attachment URLs. */
export function rewriteLocalAttachmentReferences(
  content: string,
  markdownDir: string,
  uploaded: Map<string, string>,
): string {
  return content.replace(
    new RegExp(MARKDOWN_LINK_OR_IMAGE_SOURCE, "g"),
    (whole: string, opening: string, target: string, closing: string) => {
      const rawTarget = normalizeMarkdownUrl(target);
      if (!isLocalAssetReference(rawTarget)) return whole;

      const uploadedUrl = uploaded.get(pyResolve(resolveAssetPath(rawTarget, markdownDir)));
      if (!uploadedUrl) return whole;
      return `${opening}<${uploadedUrl}>${closing}`;
    },
  );
}

/** Run the CLI and return a process exit code. */
export async function run(argv: readonly string[], io: Output = processOutput): Promise<number> {
  const parsed = parseCli(CLI, argv, io);
  if (typeof parsed === "number") return parsed;

  const file = parsed.positionals[0];
  const noRichLinks = flagOption(parsed, "no-rich-links");
  if (!file) {
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
    // A file with clickup-list but no clickup-task-id creates the task first.
    const createTarget = stringOption(parsed, "task-id") ? null : readCreateTaskTarget(file);
    if (createTarget) {
      const created = await createTaskFromFile(file, createTarget, stringOption(parsed, "team-id"), apiToken, io);
      if (typeof created === "number") return created;
      destination = created;
    } else {
      destination = resolveDestination(file, {
        taskId: stringOption(parsed, "task-id"),
        teamId: stringOption(parsed, "team-id"),
      });
    }
  } catch (error) {
    if (error instanceof FileNotFoundError || error instanceof ValueError) {
      err(io, error.message);
      return 1;
    }
    if (error instanceof HttpError) return reportHttpError(error, io);
    if (error instanceof NetworkError) {
      err(io, `Network error: ${error.reason}`);
      return 1;
    }
    throw error;
  }

  let prepared: PreparedTaskContent;
  try {
    prepared = await prepareMarkdownTaskContent(file, apiToken, destination, { richLinks: !noRichLinks });
  } catch (error) {
    if (error instanceof FileNotFoundError || error instanceof ValueError) {
      err(io, error.message);
      return 1;
    }
    if (error instanceof HttpError) return reportHttpError(error, io);
    if (error instanceof NetworkError) {
      err(io, `Network error: ${error.reason}`);
      return 1;
    }
    throw error;
  }

  info(io, `File        : ${pyResolve(file)} (${formatThousands(pyLen(prepared.content))} chars)`);
  if (destination.customTaskId) {
    info(io, `Target      : task=${destination.taskId}  team=${destination.teamId}`);
  } else {
    info(io, `Target      : task=${destination.taskId}`);
  }
  const reusedCount = prepared.reusedAttachments.size;
  info(io, `Attachments : uploaded=${prepared.uploadedAttachments.size}${reusedCount ? `  reused=${reusedCount}` : ""}`);
  if (prepared.title) {
    info(io, `Title       : ${prepared.title}`);
  }
  if (prepared.outcome) {
    const ellipsis = pyLen(prepared.outcome) > 100 ? "..." : "";
    info(io, `Outcome     : ${pySlice(prepared.outcome, 0, 100)}${ellipsis}`);
  }
  const fieldSummary = Object.entries(prepared.fieldSources).map(([key, value]) => `${key}=${value}`);
  if (fieldSummary.length) {
    info(io, `Fields      : ${fieldSummary.join("  ")}`);
  }
  for (const [uploadedPath, url] of prepared.uploadedAttachments) {
    info(io, `Attachment  : ${path.basename(uploadedPath)} -> ${url}`);
  }
  for (const [reusedPath, url] of prepared.reusedAttachments) {
    info(io, `Attachment  : ${path.basename(reusedPath)} -> ${url} (already attached)`);
  }
  if (!noRichLinks) {
    info(io, `Links       : normalized=${prepared.normalizedLinks}`);
  }
  for (const checklist of prepared.checklists) {
    const count = checklist.items.length;
    info(io, `Checklist   : ${checklist.name} (${count} ${count === 1 ? "item" : "items"})`);
  }
  print(io);

  try {
    await updateTaskDescription(destination, prepared.content, apiToken, prepared.title, prepared.fields);
  } catch (error) {
    if (error instanceof HttpError) return reportHttpError(error, io);
    if (error instanceof NetworkError) {
      err(io, `Network error: ${error.reason}`);
      return 1;
    }
    err(io, `Unexpected error: ${errorMessage(error)}`);
    return 1;
  }

  if (prepared.outcome) {
    const outcomeFieldId = getEnvValue("CLICKUP_OUTCOME_FIELD_ID").trim() || DEFAULT_OUTCOME_FIELD_ID;
    try {
      await setTaskCustomField(destination, outcomeFieldId, prepared.outcome, apiToken);
      ok(io, `Outcome field updated (${outcomeFieldId})`);
    } catch (error) {
      if (error instanceof HttpError) return reportHttpError(error, io);
      if (error instanceof NetworkError) {
        err(io, `Network error: ${error.reason}`);
        return 1;
      }
      err(io, `Unexpected error setting outcome: ${errorMessage(error)}`);
      return 1;
    }
  }

  if (prepared.checklists.length) {
    try {
      const synced = await syncChecklists(destination, prepared.checklists, apiToken);
      ok(
        io,
        `Checklists synced (checklists created=${synced.checklistsCreated}, items created=${synced.itemsCreated}, items updated=${synced.itemsUpdated})`,
      );
    } catch (error) {
      if (error instanceof HttpError) return reportHttpError(error, io);
      if (error instanceof NetworkError) {
        err(io, `Network error: ${error.reason}`);
        return 1;
      }
      err(io, `Unexpected error syncing checklists: ${errorMessage(error)}`);
      return 1;
    }
  }

  print(io);
  ok(io, "Task description updated");
  ok(io, `URL: ${BOLD}${buildTaskUrl(destination.taskId, destination.teamId)}${RESET}`);
  return 0;
}

/**
 * Validate the file, create the task in its List, and save the new ID to the
 * front matter before anything else, so a later failure never leads to a
 * duplicate task on the next run. Returns the new task's destination, or an
 * exit code when the ID could not be saved.
 */
async function createTaskFromFile(
  file: string,
  target: CreateTaskTarget,
  teamIdOption: string,
  apiToken: string,
  io: Output,
): Promise<TaskDestination | number> {
  const name = validateNewTaskFile(file);
  const [metadata] = parseFrontMatter(readMarkdown(file));
  const teamId = teamIdOption.trim() || (metadata["clickup-team-id"] ?? "").trim() || getEnvValue("CLICKUP_TEAM_ID").trim();
  const parent = target.parentTask ? await resolveParentTask(target.parentTask, teamId, apiToken) : null;

  const created = await createTask(target.listId, { name, parent }, apiToken);
  const id = created.id as string;
  const customId = typeof created.custom_id === "string" ? created.custom_id.trim() : "";
  const createdTeam = (typeof created.team_id === "string" ? created.team_id : "") || teamId;
  const entries: Array<[string, string]> =
    customId && createdTeam ? [["clickup-task-id", customId], ["clickup-team-id", createdTeam]] : [["clickup-task-id", id]];
  info(io, `Created     : task ${customId || id} in List ${target.listId}${parent ? ` (subtask of ${parent})` : ""}`);

  try {
    setFrontMatterValues(file, entries);
  } catch (error) {
    err(io, `Task ${customId || id} was created, but saving clickup-task-id to ${file} failed: ${errorMessage(error)}`);
    err(io, "Add that clickup-task-id line to the front matter yourself before running again.");
    return 1;
  }
  info(io, `Saved       : clickup-task-id to ${file}`);
  return taskDestination(id);
}

/** CLI entry point. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await run(argv);
}
