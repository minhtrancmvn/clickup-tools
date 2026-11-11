/** Send ClickUp task summaries to a Telegram chat through a bot. */

import {
  HttpError,
  NetworkError,
  ValueError,
  err,
  flagOption,
  htmlEscape,
  httpRequest,
  info,
  isDict,
  ok,
  parseCli,
  parseJson,
  print,
  processOutput,
  pyLen,
  pyOr,
  pyRepr,
  pyStr,
  pyTruthy,
  stringOption,
  usageError,
  type CliSpec,
  type Output,
  type ParsedCli,
} from "./common.js";
import { getApiToken, getEnvValue } from "./env.js";
import { getTaskWithSubtasks, resolveDestination } from "./read-task.js";

export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
export const BOT_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
export const CHAT_ID_ENV = "TELEGRAM_CHAT_ID";
export const THREAD_ID_ENV = "TELEGRAM_THREAD_ID";

type Json = Record<string, unknown>;

/** The task fields included in a Telegram message. */
export interface TaskSummary {
  taskId: string;
  name: string;
  url: string;
}

/** A chat that has messaged the bot. */
export interface ChatInfo {
  chatId: number;
  chatType: string;
  label: string;
}

/** A forum topic seen in a message sent to the bot. */
export interface TopicInfo {
  chatId: number;
  threadId: number;
  name: string;
}

/** Raised when the Telegram Bot API rejects a request. */
export class TelegramError extends Error {
  override name = "TelegramError";
}

function textOf(value: unknown): string {
  return pyTruthy(value) ? pyStr(value) : "";
}

/** Reduce a ClickUp task payload to the fields the message needs. */
export function summarizeTask(task: unknown): TaskSummary {
  const record = isDict(task) ? task : {};
  return {
    taskId: textOf(pyOr(record.custom_id, record.id, "")).trim(),
    name: textOf(record.name).trim(),
    url: textOf(record.url).trim(),
  };
}

/** Build a Telegram HTML message: optional intro line, then one linked line per task. */
export function buildMessage(tasks: readonly TaskSummary[], { intro = "" }: { intro?: string } = {}): string {
  const lines: string[] = [];
  if (intro.trim()) lines.push(htmlEscape(intro.trim()));

  tasks.forEach((task, index) => {
    let taskLabel = htmlEscape(task.taskId || "Task");
    if (task.url) taskLabel = `<a href="${htmlEscape(task.url, true)}">${taskLabel}</a>`;
    lines.push(`${index + 1}. ${taskLabel} ${htmlEscape(task.name)}`);
  });
  return lines.join("\n");
}

/**
 * Call a Telegram Bot API method and return its result. Error messages never
 * include the request URL or the bot token.
 */
export async function telegramCall(botToken: string, method: string, payload: Json = {}): Promise<unknown> {
  const redact = (text: string): string => (botToken ? text.split(botToken).join("<redacted>") : text);

  let text: string;
  try {
    text = await httpRequest(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      let description = "";
      try {
        const detail: unknown = JSON.parse(error.body || "{}");
        if (isDict(detail)) description = textOf(detail.description);
      } catch {
        // Keep the bare status line.
      }
      throw new TelegramError(redact(`Telegram ${method} failed: HTTP ${error.code} ${description}`.trim()));
    }
    if (error instanceof NetworkError) {
      throw new TelegramError(redact(`Telegram ${method} failed: ${error.reason}`));
    }
    throw error;
  }

  const body = parseJson(text);
  if (!isDict(body) || !pyTruthy(body.ok)) {
    const description = isDict(body) ? textOf(body.description) : "";
    throw new TelegramError(`Telegram ${method} failed: ${description || "unexpected response"}`);
  }
  return body.result;
}

/** List unique chats found in getUpdates results, in first-seen order. */
export function extractChats(updates: readonly unknown[]): ChatInfo[] {
  const chats = new Map<number, ChatInfo>();
  for (const update of updates) {
    if (!isDict(update)) continue;
    for (const key of ["message", "edited_message", "channel_post", "my_chat_member"]) {
      const event = update[key];
      const chat = isDict(event) ? event.chat : null;
      if (!isDict(chat) || !Number.isInteger(chat.id)) continue;
      const chatId = chat.id as number;
      if (chats.has(chatId)) continue;

      const name = [chat.first_name, chat.last_name].filter(pyTruthy).map(pyStr).join(" ");
      let label = textOf(pyOr(chat.title, name, ""));
      if (pyTruthy(chat.username)) label = `${label} (@${pyStr(chat.username)})`.trim();
      chats.set(chatId, { chatId, chatType: textOf(chat.type), label });
    }
  }
  return [...chats.values()];
}

/**
 * List unique forum topics found in getUpdates results, in first-seen order.
 * The Bot API cannot list topics, so a topic is only known once a visible
 * message is posted in it; the name comes from the topic-created service message.
 */
export function extractTopics(updates: readonly unknown[]): TopicInfo[] {
  const topics = new Map<string, TopicInfo>();
  for (const update of updates) {
    if (!isDict(update)) continue;
    const message = pyOr(update.message, update.edited_message);
    if (!isDict(message) || !pyTruthy(message.is_topic_message)) continue;

    const chat = message.chat;
    const threadId = message.message_thread_id;
    if (!isDict(chat) || !Number.isInteger(chat.id) || !Number.isInteger(threadId)) continue;

    const chatId = chat.id as number;
    const key = `${chatId}:${threadId as number}`;
    const reply = isDict(message.reply_to_message) ? message.reply_to_message : {};
    const created = pyOr(message.forum_topic_created, reply.forum_topic_created, {});
    const name = isDict(created) ? textOf(created.name) : "";
    const existing = topics.get(key);
    if (!existing || (name && !existing.name)) {
      topics.set(key, { chatId, threadId: threadId as number, name });
    }
  }
  return [...topics.values()];
}

/** Read an ID from env/.env, dropping a trailing " # comment" as dotenv files allow. */
export function envIdValue(name: string): string {
  let value = getEnvValue(name);
  for (const marker of [" #", "\t#"]) {
    const index = value.indexOf(marker);
    if (index !== -1) value = value.slice(0, index);
  }
  return value.trim();
}

export const PROG = "clickup-send-telegram";

const USAGE = "usage: clickup-send-telegram [-h] {chats,send} ...\n";

const HELP = `${USAGE}
Send ClickUp tasks to a Telegram chat through a bot. Reads TELEGRAM_BOT_TOKEN
and TELEGRAM_CHAT_ID from the environment or .env.

positional arguments:
  {chats,send}
    chats       List chats and forum topics that have messaged the bot, to
                find chat and topic IDs.
    send        Send one message listing the given tasks.

options:
  -h, --help    show this help message and exit
`;

const TOP_CLI = { prog: PROG, usage: USAGE };

const CHATS_USAGE = "usage: clickup-send-telegram chats [-h]\n";

export const CHATS_CLI: CliSpec = {
  prog: `${PROG} chats`,
  usage: CHATS_USAGE,
  parent: TOP_CLI,
  help: `${CHATS_USAGE}
options:
  -h, --help  show this help message and exit
`,
  maxPositionals: 0,
  options: { help: { type: "boolean", short: "h" } },
};

const SEND_USAGE = `usage: clickup-send-telegram send [-h] [--chat-id CHAT_ID]
                                  [--thread-id THREAD_ID] [--intro INTRO]
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
  --chat-id CHAT_ID     Telegram chat ID. Defaults to TELEGRAM_CHAT_ID.
  --thread-id THREAD_ID
                        Forum topic ID to post in. Defaults to
                        TELEGRAM_THREAD_ID; omit both to post in General.
  --intro INTRO         Optional text shown above the task list.
  --team-id TEAM_ID     ClickUp team ID for custom task IDs.
  --dry-run             Print the message instead of sending it.
`,
  maxPositionals: Number.POSITIVE_INFINITY,
  options: {
    help: { type: "boolean", short: "h" },
    "chat-id": { type: "string" },
    "thread-id": { type: "string" },
    intro: { type: "string" },
    "team-id": { type: "string" },
    "dry-run": { type: "boolean" },
  },
};

export async function runChats(botToken: string, io: Output): Promise<number> {
  const result = await telegramCall(botToken, "getUpdates");
  const updates = Array.isArray(result) ? result : [];
  const chats = extractChats(updates);
  if (!chats.length) {
    info(io, "No chats found. Ask the recipient to open the bot and press Start, then run this again.");
    return 0;
  }
  for (const chat of chats) {
    print(io, `${chat.chatId}\t${chat.chatType}\t${chat.label}`);
  }
  for (const topic of extractTopics(updates)) {
    print(io, `${topic.chatId}\ttopic ${topic.threadId}\t${topic.name || "(name not in update)"}`);
  }
  return 0;
}

export async function runSend(parsed: ParsedCli, botToken: string, io: Output): Promise<number> {
  const clickupToken = getApiToken();
  if (!clickupToken) {
    err(io, "CLICKUP_API_TOKEN is not set. Add it to .env or the environment.");
    return 1;
  }

  const summaries: TaskSummary[] = [];
  for (const taskValue of parsed.positionals) {
    const destination = resolveDestination(taskValue, { teamId: stringOption(parsed, "team-id") });
    summaries.push(summarizeTask(await getTaskWithSubtasks(destination, clickupToken)));
  }

  const message = buildMessage(summaries, { intro: stringOption(parsed, "intro") });
  const length = pyLen(message);
  if (length > TELEGRAM_MAX_MESSAGE_CHARS) {
    err(io, `Message is ${length} characters; Telegram allows ${TELEGRAM_MAX_MESSAGE_CHARS}. Send fewer tasks.`);
    return 1;
  }

  if (flagOption(parsed, "dry-run")) {
    print(io, message);
    return 0;
  }

  const chatId = stringOption(parsed, "chat-id").trim() || envIdValue(CHAT_ID_ENV);
  if (!chatId) {
    err(io, `No chat ID. Pass --chat-id or set ${CHAT_ID_ENV}. Run 'clickup-send-telegram chats' to find it.`);
    return 1;
  }

  const threadValue = stringOption(parsed, "thread-id").trim() || envIdValue(THREAD_ID_ENV);
  if (threadValue && !/^\d+$/.test(threadValue)) {
    err(io, `Topic ID must be a positive number, got ${pyRepr(threadValue)}.`);
    return 1;
  }

  if (!botToken) {
    err(io, `${BOT_TOKEN_ENV} is not set. Add it to .env or the environment.`);
    return 1;
  }

  const payload: Json = {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (threadValue) payload.message_thread_id = Number(threadValue);

  const result = await telegramCall(botToken, "sendMessage", payload);
  const messageId = isDict(result) ? result.message_id : null;
  const where = `chat ${chatId}${threadValue ? ` topic ${threadValue}` : ""}`;
  ok(io, `Sent ${summaries.length} task(s) to ${where} (message ${pyStr(messageId)})`);
  return 0;
}

/** Run the CLI and return a process exit code. */
export async function run(argv: readonly string[], io: Output = processOutput): Promise<number> {
  // argparse parses top-level options up to the subcommand; unknown ones are
  // reported together with the subcommand's unrecognized arguments.
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
  if (command === undefined) {
    return usageError(TOP_CLI, io, "the following arguments are required: command");
  }
  if (command !== "chats" && command !== "send") {
    return usageError(TOP_CLI, io, `argument command: invalid choice: ${pyRepr(command)} (choose from chats, send)`);
  }

  const spec = command === "chats" ? CHATS_CLI : SEND_CLI;
  const parsed = parseCli(spec, argv.slice(index + 1), io, {
    extras: topExtras,
    validate:
      command === "send"
        ? (candidate) => (candidate.positionals.length ? null : "the following arguments are required: TASK_OR_URL")
        : undefined,
  });
  if (typeof parsed === "number") return parsed;

  const botToken = getEnvValue(BOT_TOKEN_ENV);
  try {
    if (command === "chats") {
      if (!botToken) {
        err(io, `${BOT_TOKEN_ENV} is not set. Add it to .env or the environment.`);
        return 1;
      }
      return await runChats(botToken, io);
    }
    return await runSend(parsed, botToken, io);
  } catch (error) {
    if (
      error instanceof TelegramError ||
      error instanceof ValueError ||
      error instanceof HttpError ||
      error instanceof NetworkError
    ) {
      err(io, error.message);
      return 1;
    }
    throw error;
  }
}

/** CLI entry point. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await run(argv);
}
