/** Post Markdown as a ClickUp task comment, converted to ClickUp's rich-text comment format. */

import {
  BOLD,
  RESET,
  FileNotFoundError,
  HttpError,
  NetworkError,
  ValueError,
  err,
  flagOption,
  httpRequest,
  info,
  isDict,
  ok,
  parseCli,
  parseJson,
  printMissingTokenHelp,
  processOutput,
  pySplitlines,
  reportHttpError,
  stringOption,
  type CliSpec,
  type Output,
} from "./common.js";
import { getApiToken, getEnvValue } from "./env.js";
import { resolveDestination } from "./read-task.js";
import { parseFrontMatter, readMarkdown } from "./update-page.js";
import { buildTaskUrl, taskQuery, type TaskDestination } from "./update-task.js";

/** One run of a ClickUp rich-text comment. */
export interface CommentBlock {
  text: string;
  attributes: Record<string, unknown>;
}

type InlineAttributes = { bold?: true; italic?: true; code?: true; link?: string };

const INLINE_RE =
  /(`+)([^`]+?)\1|\[([^\]]+)\]\(<?([^)\s>]+)>?\)|<(https?:\/\/[^>\s]+)>|\*\*(.+?)\*\*|__(.+?)__|\*(?![\s*])(.+?)\*|(?<![\w])_(?![\s_])(.+?)_(?![\w])/;

/** Convert inline Markdown (bold, italic, code, links) into comment runs. */
export function parseInline(text: string, attributes: InlineAttributes = {}): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  let rest = text;
  while (rest) {
    const match = INLINE_RE.exec(rest);
    if (!match) {
      blocks.push({ text: rest, attributes: { ...attributes } });
      break;
    }
    if (match.index > 0) blocks.push({ text: rest.slice(0, match.index), attributes: { ...attributes } });
    const [, , code, label, href, autolink, bold1, bold2, italic1, italic2] = match;
    if (code !== undefined) blocks.push({ text: code, attributes: { ...attributes, code: true } });
    else if (label !== undefined) blocks.push(...parseInline(label, { ...attributes, link: href! }));
    else if (autolink !== undefined) blocks.push({ text: autolink, attributes: { ...attributes, link: autolink } });
    else if (bold1 !== undefined || bold2 !== undefined) blocks.push(...parseInline((bold1 ?? bold2)!, { ...attributes, bold: true }));
    else blocks.push(...parseInline((italic1 ?? italic2)!, { ...attributes, italic: true }));
    rest = rest.slice(match.index + match[0].length);
  }
  return blocks;
}

function lineEnd(attributes: Record<string, unknown> = {}): CommentBlock {
  return { text: "\n", attributes };
}

const HEADING_RE = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const TASK_ITEM_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

function indentLevel(spaces: string): number {
  return Math.floor(spaces.replace(/\t/g, "    ").length / 2);
}

/**
 * Convert Markdown into ClickUp comment runs. Block formatting (lists, code
 * blocks, indentation) is carried on each line's "\n" run, as ClickUp expects.
 * Headings become bold lines; anything else is kept as text.
 */
export function markdownToComment(markdown: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  let inFence = false;
  const lines = pySplitlines(markdown.replace(/\s+$/, ""));

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (line) blocks.push({ text: line, attributes: {} });
      blocks.push(lineEnd({ "code-block": { "code-block": "plain" } }));
      continue;
    }

    const heading = HEADING_RE.exec(line);
    const taskItem = TASK_ITEM_RE.exec(line);
    const bullet = taskItem ? null : BULLET_RE.exec(line);
    const ordered = taskItem || bullet ? null : ORDERED_RE.exec(line);

    if (heading) {
      blocks.push(...parseInline(heading[1]!, { bold: true }), lineEnd());
    } else if (taskItem || bullet || ordered) {
      const [, spaces, ...rest] = (taskItem ?? bullet ?? ordered)!;
      const text = taskItem ? rest[1]! : rest[0]!;
      const kind = taskItem ? (taskItem[2] === " " ? "unchecked" : "checked") : bullet ? "bullet" : "ordered";
      const attributes: Record<string, unknown> = { list: { list: kind } };
      const indent = indentLevel(spaces!);
      if (indent) attributes.indent = indent;
      blocks.push(...parseInline(text), lineEnd(attributes));
    } else {
      if (line) blocks.push(...parseInline(line));
      blocks.push(lineEnd());
    }
  }

  // Merge neighbouring runs with identical formatting to keep the payload small.
  const merged: CommentBlock[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      block.text !== "\n" &&
      previous.text !== "\n" &&
      JSON.stringify(previous.attributes) === JSON.stringify(block.attributes)
    ) {
      previous.text += block.text;
    } else {
      merged.push({ text: block.text, attributes: { ...block.attributes } });
    }
  }
  return merged;
}

/** Post a rich-text comment on a task; returns the new comment ID. */
export async function createTaskComment(
  destination: TaskDestination,
  comment: CommentBlock[],
  apiToken: string,
  { notifyAll = false }: { notifyAll?: boolean } = {},
): Promise<string> {
  const body = await httpRequest(`https://api.clickup.com/api/v2/task/${destination.taskId}/comment${taskQuery(destination)}`, {
    method: "POST",
    headers: { Authorization: apiToken, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ comment, notify_all: notifyAll }),
  });
  const created = body ? parseJson(body) : {};
  return isDict(created) && created.id !== undefined && created.id !== null ? String(created.id) : "";
}

/** Plain-text form of comment runs. */
export function commentPlainText(comment: CommentBlock[]): string {
  return comment.map((block) => block.text).join("").replace(/\s+$/, "");
}

/**
 * Replace the content of an existing comment or reply. ClickUp documents only
 * comment_text for this endpoint, so the plain text is sent alongside the
 * rich-text runs.
 */
export async function updateComment(commentId: string, comment: CommentBlock[], apiToken: string): Promise<void> {
  await httpRequest(`https://api.clickup.com/api/v2/comment/${commentId}`, {
    method: "PUT",
    headers: { Authorization: apiToken, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ comment_text: commentPlainText(comment), comment }),
  });
}

/** ClickUp comment IDs are numeric; anything else would change the request path. */
export function parseCommentId(value: string): string {
  const commentId = value.trim();
  if (!/^\d+$/.test(commentId)) throw new ValueError(`Invalid comment ID: ${JSON.stringify(value)} (expected digits only).`);
  return commentId;
}

export const PROG = "clickup-comment";

const USAGE =
  "usage: clickup-comment [-h] [--file FILE | --text TEXT] [--team-id ID] [--notify-all] [--edit COMMENT_ID] [TASK_OR_URL]\n";

export const CLI: CliSpec = {
  prog: PROG,
  usage: USAGE,
  help: `${USAGE}
Post Markdown as a comment on a ClickUp task, or replace an existing
comment's content with --edit.

positional arguments:
  TASK_OR_URL           ClickUp task ID, custom task ID, or task URL (defaults
                        to the file's clickup-task-id, then CLICKUP_TASK_ID)

options:
  -h, --help            show this help message and exit
  --file FILE           Markdown file to post (front matter is not posted)
  --text TEXT           Markdown text to post
  --team-id ID          ClickUp team/workspace ID for custom task IDs
  --notify-all          Also notify yourself (assignees and watchers are
                        always notified)
  --edit COMMENT_ID     Replace the content of this comment or reply instead
                        of posting a new one (no task needed)

Supported formatting: **bold**, *italic*, \`code\`, [links](https://...),
bulleted, numbered and - [ ] checklist items (indent to nest), and code
blocks. Headings are posted as bold lines.

Comment IDs are printed when a comment is posted, and returned as "id" by
clickup-read-task --json --include-comments.

examples:
  clickup-comment OOLE-523 --text 'Deployed to **staging**, see [run](https://ci/1)'
  clickup-comment OOLE-523 --file update.md
  clickup-comment --file update.md     # task from the file's clickup-task-id
  clickup-comment --edit 90160123456789 --text 'Deployed to **production**'
`,
  maxPositionals: 1,
  options: {
    help: { type: "boolean", short: "h" },
    file: { type: "string" },
    text: { type: "string" },
    "team-id": { type: "string" },
    "notify-all": { type: "boolean" },
    edit: { type: "string" },
  },
};

/** Run the CLI and return a process exit code. */
export async function run(argv: readonly string[], io: Output = processOutput): Promise<number> {
  const parsed = parseCli(CLI, argv, io, {
    validate: (candidate) => {
      if (candidate.values.file !== undefined && candidate.values.text !== undefined) {
        return `argument --text: not allowed with argument --file`;
      }
      if (candidate.values.edit !== undefined) {
        if (candidate.positionals.length) return `argument TASK_OR_URL: not allowed with argument --edit`;
        if (candidate.values["notify-all"] !== undefined) return `argument --notify-all: not allowed with argument --edit`;
      }
      return null;
    },
  });
  if (typeof parsed === "number") return parsed;

  const file = stringOption(parsed, "file");
  const text = stringOption(parsed, "text");
  if (!file && !text) {
    io.stdout(CLI.help);
    return 0;
  }

  const apiToken = getApiToken();
  if (!apiToken) {
    printMissingTokenHelp(io);
    return 1;
  }

  try {
    let markdown = text;
    let fileTask = "";
    let fileTeam = "";
    if (file) {
      const [metadata, body] = parseFrontMatter(readMarkdown(file));
      markdown = body;
      fileTask = (metadata["clickup-task-id"] ?? "").trim();
      fileTeam = (metadata["clickup-team-id"] ?? "").trim();
    }
    if (!markdown.trim()) throw new ValueError("The comment is empty.");

    const editId = parsed.values.edit;
    if (typeof editId === "string") {
      const commentId = parseCommentId(editId);
      info(io, `Target : comment=${commentId}`);
      await updateComment(commentId, markdownToComment(markdown), apiToken);
      ok(io, `Comment ${commentId} updated`);
      return 0;
    }

    const taskValue = parsed.positionals[0] || fileTask || getEnvValue("CLICKUP_TASK_ID").trim();
    if (!taskValue) throw new ValueError("No task given. Pass TASK_OR_URL or add clickup-task-id to the file's front matter.");
    const destination = resolveDestination(taskValue, { teamId: stringOption(parsed, "team-id") || fileTeam });

    const comment = markdownToComment(markdown);
    info(io, `Target : task=${destination.taskId}${destination.customTaskId ? `  team=${destination.teamId}` : ""}`);
    const commentId = await createTaskComment(destination, comment, apiToken, { notifyAll: flagOption(parsed, "notify-all") });
    ok(io, `Comment posted${commentId ? ` (id ${commentId})` : ""}`);
    ok(io, `URL: ${BOLD}${buildTaskUrl(destination.taskId, destination.teamId)}${RESET}`);
    return 0;
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

/** CLI entry point. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await run(argv);
}
