/**
 * Pull a ClickUp Doc page or task into a Markdown file that clickup-update-page
 * / clickup-update-task can push back unchanged (pull, edit, push).
 */

import fs from "node:fs";
import path from "node:path";

import {
  FileNotFoundError,
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
  parseCli,
  parseJson,
  pathExists,
  printMissingTokenHelp,
  processOutput,
  pyLen,
  pyResolve,
  pyStr,
  pyUrlencode,
  reportHttpError,
  stringOption,
  type CliSpec,
  type Output,
} from "./common.js";
import { getApiToken, getEnvValue } from "./env.js";
import { renderChecklistSection } from "./checklists.js";
import { extractChecklists, extractOutcomeValue, extractStatus, resolveDestination, stringValue } from "./read-task.js";
import { buildPageUrl, getPage, parsePageUrl } from "./update-page.js";
import { DEFAULT_OUTCOME_FIELD_ID, isCustomTaskId, type TaskDestination } from "./update-task.js";

type Json = Record<string, unknown>;

/** A pulled page or task, ready to write. */
export interface PulledDocument {
  markdown: string;
  title: string;
  /** Things the file leaves out or changes, worth telling the user. */
  notes: string[];
}

/** Quote a front matter value only when the parser would otherwise change it. */
export function frontMatterValue(value: string): string {
  if (value === value.trim() && !/^['"]/.test(value) && value !== "") return value;
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

/** Assemble front matter, an H1 title and the body into one Markdown document. */
export function buildMarkdownFile(front: Array<[string, string]>, title: string, body: string): string {
  const header = ["---", ...front.map(([key, value]) => `${key}: ${frontMatterValue(value)}`), "---", ""].join("\n");
  const text = body.replace(/^\n+/, "");
  return `${header}\n# ${title}\n\n${text}${text && !text.endsWith("\n") ? "\n" : ""}`;
}

/** Format milliseconds as the time_estimate front matter value ("1h 30m"); "" below one minute. */
export function formatEstimate(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].filter(Boolean).join(" ");
}

/** Fetch a Doc page as Markdown with clickup-page (and subtitle) front matter. */
export async function pullPage(pageUrl: string, apiToken: string): Promise<PulledDocument> {
  const [workspaceId, docId, pageId] = parsePageUrl(pageUrl);
  const page = await getPage(workspaceId, docId, pageId, apiToken, "text/md");
  const record: Json = isDict(page) ? page : {};
  const title = stringValue(record.name) || "Untitled";
  const front: Array<[string, string]> = [["clickup-page", buildPageUrl(workspaceId, docId, pageId)]];
  const subtitle = stringValue(record.sub_title);
  if (subtitle) front.push(["subtitle", subtitle]);
  const content = typeof record.content === "string" ? record.content : "";
  return { markdown: buildMarkdownFile(front, title, content), title, notes: [] };
}

/** Fetch a task with its Markdown description. */
export async function getTaskForPull(destination: TaskDestination, apiToken: string): Promise<Json> {
  const params: Record<string, string> = { include_markdown_description: "true" };
  if (destination.customTaskId) {
    params.custom_task_ids = "true";
    params.team_id = destination.teamId;
  }
  const body = await httpRequest(`https://api.clickup.com/api/v2/task/${destination.taskId}?${pyUrlencode(params)}`, {
    headers: { Authorization: apiToken, Accept: "application/json" },
    timeoutMs: 15_000,
  });
  const task = parseJson(body);
  return isDict(task) ? task : {};
}

/**
 * Build the task file: routing and field front matter, the name as H1, then the
 * Markdown description. Start/due dates are left out because ClickUp does not
 * report whether they carry a time, so pushing them back could change them.
 */
export function taskToMarkdown(task: Json, destination: TaskDestination, outcomeFieldId: string): PulledDocument {
  const notes: string[] = [];
  const front: Array<[string, string]> = [];
  const taskRef = stringValue(task.custom_id) || stringValue(task.id) || destination.taskId;
  front.push(["clickup-task-id", taskRef]);
  if (isCustomTaskId(taskRef)) {
    const teamId = stringValue(task.team_id) || destination.teamId;
    if (teamId) front.push(["clickup-team-id", teamId]);
  }

  const [outcomeAvailable, outcome] = extractOutcomeValue(task, { outcomeFieldId });
  if (outcomeAvailable && outcome !== "Not set") {
    if (outcome.includes("\n")) notes.push("Outcome has several lines, so it was left out of the front matter.");
    else front.push(["outcome", outcome]);
  }

  const status = extractStatus(task);
  if (status !== "Not set") front.push(["status", status]);
  const priority = isDict(task.priority) ? stringValue(task.priority.priority) : "";
  if (priority) front.push(["priority", priority]);
  if (task.points !== null && task.points !== undefined && task.points !== "") front.push(["points", pyStr(task.points)]);
  const estimate = typeof task.time_estimate === "number" ? formatEstimate(task.time_estimate) : "";
  if (estimate) front.push(["time_estimate", estimate]);
  if (task.start_date || task.due_date) {
    notes.push("Start and due dates are not written: ClickUp does not say whether they include a time.");
  }

  const description =
    typeof task.markdown_description === "string" && task.markdown_description.trim()
      ? task.markdown_description
      : stringValue(task.description);
  // Checklists come back as `## Checklist: Name` sections, which update-task syncs.
  const sections = extractChecklists(task).map((checklist) => renderChecklistSection(checklist).trimEnd());
  const body = [description.trimEnd(), ...sections].filter(Boolean).join("\n\n");
  const title = stringValue(task.name) || "Untitled";
  return { markdown: buildMarkdownFile(front, title, body), title, notes };
}

/** Write a pulled file, refusing to replace an existing one unless asked. */
export function writePulledFile(filePath: string, content: string, overwrite = false): void {
  if (pathExists(filePath) && !overwrite) {
    throw new ValueError(`${filePath} already exists. Pass --force to overwrite it.`);
  }
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

const OUTPUT_OPTIONS = {
  help: { type: "boolean", short: "h" },
  output: { type: "string", short: "o" },
  force: { type: "boolean" },
} as const;

const PAGE_USAGE = "usage: clickup-pull-page [-h] [-o FILE] [--force] PAGE_URL\n";

export const PAGE_CLI: CliSpec = {
  prog: "clickup-pull-page",
  usage: PAGE_USAGE,
  help: `${PAGE_USAGE}
Save a ClickUp Doc page as Markdown that clickup-update-page can push back.

positional arguments:
  PAGE_URL              ClickUp Doc page URL

options:
  -h, --help            show this help message and exit
  -o, --output FILE     Write to FILE instead of standard output
  --force               Overwrite FILE if it already exists

examples:
  clickup-pull-page 'https://app.clickup.com/123/v/dc/abc/xyz' -o notes.md
  clickup-pull-page 'https://app.clickup.com/123/v/dc/abc/xyz' > notes.md
`,
  maxPositionals: 1,
  options: { ...OUTPUT_OPTIONS },
};

const TASK_USAGE = "usage: clickup-pull-task [-h] [--team-id ID] [-o FILE] [--force] [TASK_OR_URL]\n";

export const TASK_CLI: CliSpec = {
  prog: "clickup-pull-task",
  usage: TASK_USAGE,
  help: `${TASK_USAGE}
Save a ClickUp task as Markdown that clickup-update-task can push back.

positional arguments:
  TASK_OR_URL           ClickUp task ID, custom task ID, or task URL (defaults
                        to CLICKUP_TASK_ID)

options:
  -h, --help            show this help message and exit
  --team-id ID          ClickUp team/workspace ID for custom task IDs
  -o, --output FILE     Write to FILE instead of standard output
  --force               Overwrite FILE if it already exists

examples:
  clickup-pull-task OOLE-523 -o OOLE-523.md
  clickup-pull-task 'https://app.clickup.com/t/1234567890/OOLE-523' > task.md
`,
  maxPositionals: 1,
  options: { ...OUTPUT_OPTIONS, "team-id": { type: "string" } },
};

/** Print or write a pulled document; status lines only when writing a file. */
function emit(document: PulledDocument, output: string, force: boolean, io: Output): number {
  if (!output) {
    io.stdout(document.markdown);
    for (const note of document.notes) err(io, note);
    return 0;
  }
  try {
    writePulledFile(output, document.markdown, force);
  } catch (error) {
    if (error instanceof ValueError) {
      err(io, error.message);
      return 1;
    }
    err(io, `Could not write ${output}: ${errorMessage(error)}`);
    return 1;
  }
  info(io, `Pulled : ${document.title}`);
  info(io, `Wrote  : ${pyResolve(output)} (${formatThousands(pyLen(document.markdown))} chars)`);
  for (const note of document.notes) info(io, `Note   : ${note}`);
  return 0;
}

async function guarded(io: Output, action: () => Promise<number>): Promise<number> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ValueError || error instanceof FileNotFoundError) {
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
}

/** clickup-pull-page */
export async function runPullPage(argv: readonly string[], io: Output = processOutput): Promise<number> {
  const parsed = parseCli(PAGE_CLI, argv, io);
  if (typeof parsed === "number") return parsed;
  const pageUrl = parsed.positionals[0];
  if (!pageUrl) {
    io.stdout(PAGE_CLI.help);
    return 0;
  }
  const apiToken = getApiToken();
  if (!apiToken) {
    printMissingTokenHelp(io);
    return 1;
  }
  return guarded(io, async () =>
    emit(await pullPage(pageUrl, apiToken), stringOption(parsed, "output"), flagOption(parsed, "force"), io),
  );
}

/** clickup-pull-task */
export async function runPullTask(argv: readonly string[], io: Output = processOutput): Promise<number> {
  const parsed = parseCli(TASK_CLI, argv, io);
  if (typeof parsed === "number") return parsed;
  const taskValue = parsed.positionals[0] || getEnvValue("CLICKUP_TASK_ID").trim();
  if (!taskValue) {
    io.stdout(TASK_CLI.help);
    return 0;
  }
  const apiToken = getApiToken();
  if (!apiToken) {
    printMissingTokenHelp(io);
    return 1;
  }
  return guarded(io, async () => {
    const destination = resolveDestination(taskValue, { teamId: stringOption(parsed, "team-id") });
    const outcomeFieldId = getEnvValue("CLICKUP_OUTCOME_FIELD_ID").trim() || DEFAULT_OUTCOME_FIELD_ID;
    const document = taskToMarkdown(await getTaskForPull(destination, apiToken), destination, outcomeFieldId);
    return emit(document, stringOption(parsed, "output"), flagOption(parsed, "force"), io);
  });
}

export async function mainPullPage(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runPullPage(argv);
}

export async function mainPullTask(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runPullTask(argv);
}
