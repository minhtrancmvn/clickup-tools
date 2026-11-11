/** Send ClickUp task lists to a ClickUp Chat channel (v3 Chat API). */

import {
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
  print,
  printMissingTokenHelp,
  processOutput,
  pyRepr,
  pyStr,
  pyUrlencode,
  reportHttpError,
  stringOption,
  usageError,
  type CliSpec,
  type Output,
  type ParsedCli,
} from "./common.js";
import { getApiToken } from "./env.js";
import { getTaskWithSubtasks, resolveDestination } from "./read-task.js";
import { envIdValue, summarizeTask, type TaskSummary } from "./send-telegram.js";

export const CHANNEL_ENV = "CLICKUP_CHAT_CHANNEL_ID";
/** Safety cap on channel listing pages. */
const MAX_CHANNEL_PAGES = 20;

/** A Chat channel, DM or group DM. */
export interface ChatChannel {
  id: string;
  type: string;
  name: string;
}

/** Escape characters that ClickUp Chat Markdown would otherwise format. */
export function escapeChatMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>~|])/g, "\\$1");
}

/** Build the Chat message: optional intro line, then one numbered line per task with the ID linked. */
export function buildChatMessage(tasks: readonly TaskSummary[], { intro = "" }: { intro?: string } = {}): string {
  const lines: string[] = [];
  if (intro.trim()) lines.push(intro.trim(), "");
  tasks.forEach((task, index) => {
    const label = escapeChatMarkdown(task.taskId || "Task");
    const linked = task.url ? `[${label}](${task.url})` : label;
    lines.push(`${index + 1}. ${linked} ${escapeChatMarkdown(task.name)}`.trimEnd());
  });
  return lines.join("\n");
}

function headers(apiToken: string, withBody = false): Record<string, string> {
  return withBody
    ? { Authorization: apiToken, "Content-Type": "application/json", Accept: "application/json" }
    : { Authorization: apiToken, Accept: "application/json" };
}

/** List the Chat channels (including DMs) the token can see. */
export async function listChannels(workspaceId: string, apiToken: string): Promise<ChatChannel[]> {
  const channels: ChatChannel[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
    const params: Record<string, string> = { limit: "100" };
    if (cursor) params.cursor = cursor;
    const payload = parseJson(
      await httpRequest(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/chat/channels?${pyUrlencode(params)}`, {
        headers: headers(apiToken),
        timeoutMs: 15_000,
      }),
    );
    const record = isDict(payload) ? payload : {};
    for (const channel of Array.isArray(record.data) ? record.data.filter(isDict) : []) {
      channels.push({
        id: pyStr(channel.id ?? ""),
        type: typeof channel.type === "string" ? channel.type : "",
        name: typeof channel.name === "string" && channel.name.trim() ? channel.name.trim() : "(direct message)",
      });
    }
    cursor = typeof record.next_cursor === "string" ? record.next_cursor : "";
    if (!cursor) break;
  }
  return channels;
}

/** Post a Markdown message to a channel; returns the message ID when ClickUp sends one. */
export async function sendChatMessage(workspaceId: string, channelId: string, content: string, apiToken: string): Promise<string> {
  const body = await httpRequest(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/chat/channels/${channelId}/messages`, {
    method: "POST",
    headers: headers(apiToken, true),
    body: JSON.stringify({ type: "message", content, content_format: "text/md" }),
  });
  const created = body ? parseJson(body) : {};
  return isDict(created) && created.id !== undefined && created.id !== null ? String(created.id) : "";
}

export const PROG = "clickup-send-chat";

const USAGE = "usage: clickup-send-chat [-h] {channels,send} ...\n";

const HELP = `${USAGE}
Send ClickUp tasks to a ClickUp Chat channel. Reads CLICKUP_API_TOKEN,
CLICKUP_TEAM_ID and CLICKUP_CHAT_CHANNEL_ID from the environment or .env.

positional arguments:
  {channels,send}
    channels    List Chat channels and their IDs.
    send        Send one message listing the given tasks.

options:
  -h, --help    show this help message and exit
`;

const TOP_CLI = { prog: PROG, usage: USAGE };

const CHANNELS_USAGE = "usage: clickup-send-chat channels [-h] [--team-id TEAM_ID]\n";

export const CHANNELS_CLI: CliSpec = {
  prog: `${PROG} channels`,
  usage: CHANNELS_USAGE,
  parent: TOP_CLI,
  help: `${CHANNELS_USAGE}
options:
  -h, --help         show this help message and exit
  --team-id TEAM_ID  ClickUp workspace ID. Defaults to CLICKUP_TEAM_ID.
`,
  maxPositionals: 0,
  options: { help: { type: "boolean", short: "h" }, "team-id": { type: "string" } },
};

const SEND_USAGE = `usage: clickup-send-chat send [-h] [--channel-id CHANNEL_ID] [--intro INTRO]
                              [--team-id TEAM_ID] [--dry-run]
                              TASK_OR_URL [TASK_OR_URL ...]
`;

export const SEND_CLI: CliSpec = {
  prog: `${PROG} send`,
  usage: SEND_USAGE,
  parent: TOP_CLI,
  help: `${SEND_USAGE}
positional arguments:
  TASK_OR_URL           Task IDs, custom IDs, or task URLs.

options:
  -h, --help            show this help message and exit
  --channel-id CHANNEL_ID
                        Chat channel ID. Defaults to CLICKUP_CHAT_CHANNEL_ID.
  --intro INTRO         Optional Markdown shown above the task list.
  --team-id TEAM_ID     ClickUp workspace ID. Defaults to CLICKUP_TEAM_ID.
  --dry-run             Print the message instead of sending it.
`,
  maxPositionals: Number.POSITIVE_INFINITY,
  options: {
    help: { type: "boolean", short: "h" },
    "channel-id": { type: "string" },
    intro: { type: "string" },
    "team-id": { type: "string" },
    "dry-run": { type: "boolean" },
  },
};

function workspaceIdFrom(parsed: ParsedCli): string {
  const workspaceId = stringOption(parsed, "team-id").trim() || envIdValue("CLICKUP_TEAM_ID");
  if (!workspaceId) throw new ValueError("CLICKUP_TEAM_ID is not set. Add it to .env or pass --team-id.");
  return workspaceId;
}

async function runChannels(parsed: ParsedCli, apiToken: string, io: Output): Promise<number> {
  const channels = await listChannels(workspaceIdFrom(parsed), apiToken);
  if (!channels.length) {
    info(io, "No Chat channels found for this token.");
    return 0;
  }
  for (const channel of channels) print(io, `${channel.id}\t${channel.type}\t${channel.name}`);
  return 0;
}

async function runSend(parsed: ParsedCli, apiToken: string, io: Output): Promise<number> {
  const summaries: TaskSummary[] = [];
  for (const taskValue of parsed.positionals) {
    const destination = resolveDestination(taskValue, { teamId: stringOption(parsed, "team-id") });
    summaries.push(summarizeTask(await getTaskWithSubtasks(destination, apiToken)));
  }
  const message = buildChatMessage(summaries, { intro: stringOption(parsed, "intro") });

  if (flagOption(parsed, "dry-run")) {
    print(io, message);
    return 0;
  }

  const channelId = stringOption(parsed, "channel-id").trim() || envIdValue(CHANNEL_ENV);
  if (!channelId) {
    err(io, `No channel ID. Pass --channel-id or set ${CHANNEL_ENV}. Run 'clickup-send-chat channels' to find it.`);
    return 1;
  }
  const messageId = await sendChatMessage(workspaceIdFrom(parsed), channelId, message, apiToken);
  ok(io, `Sent ${summaries.length} task(s) to channel ${channelId}${messageId ? ` (message ${messageId})` : ""}`);
  return 0;
}

/** Run the CLI and return a process exit code. */
export async function run(argv: readonly string[], io: Output = processOutput): Promise<number> {
  // Like argparse: top-level options up to the subcommand; unknown ones are reported with its extras.
  const topExtras: string[] = [];
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith("-") && argv[index] !== "-") {
    const arg = argv[index]!;
    index++;
    if (arg === "--") break;
    if (arg === "-h" || (arg.length > 2 && "--help".startsWith(arg))) {
      io.stdout(HELP);
      return 0;
    }
    topExtras.push(arg);
  }

  const command = argv[index];
  if (command === undefined) return usageError(TOP_CLI, io, "the following arguments are required: command");
  if (command !== "channels" && command !== "send") {
    return usageError(TOP_CLI, io, `argument command: invalid choice: ${pyRepr(command)} (choose from channels, send)`);
  }

  const spec = command === "channels" ? CHANNELS_CLI : SEND_CLI;
  const parsed = parseCli(spec, argv.slice(index + 1), io, {
    extras: topExtras,
    validate:
      command === "send"
        ? (candidate) => (candidate.positionals.length ? null : "the following arguments are required: TASK_OR_URL")
        : undefined,
  });
  if (typeof parsed === "number") return parsed;

  const apiToken = getApiToken();
  if (!apiToken) {
    printMissingTokenHelp(io);
    return 1;
  }

  try {
    return command === "channels" ? await runChannels(parsed, apiToken, io) : await runSend(parsed, apiToken, io);
  } catch (error) {
    if (error instanceof ValueError) {
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
