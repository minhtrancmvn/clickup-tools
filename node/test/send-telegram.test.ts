import { beforeEach, describe, expect, it, vi } from "vitest";

import { BufferedOutput } from "../src/common.js";
import {
  TelegramError,
  buildMessage,
  extractChats,
  extractTopics,
  run,
  summarizeTask,
  telegramCall,
  type TaskSummary,
} from "../src/send-telegram.js";
import { bodyJson, jsonResponse, stubFetch, type FetchCall, type FetchHandler } from "./helpers.js";

const TASK_PAYLOAD = {
  id: "z94x8ecybd",
  custom_id: "OOLE-546",
  name: "[Mobile] [Sign Up] Title <not> enforced & skipped",
  status: { status: "to do" },
  assignees: [{ username: "Khánh Võ" }, { email: "dev@example.com" }, "bad"],
  url: "https://app.clickup.com/t/z94x8ecybd",
};

const CLICKUP_PREFIX = "https://api.clickup.com/";
const TELEGRAM_PREFIX = "https://api.telegram.org/";
const SEND_MESSAGE_URL = "https://api.telegram.org/bot123:SECRET/sendMessage";

describe("SummarizeAndBuildTests", () => {
  it("summarize_task_prefers_custom_id", () => {
    const summary = summarizeTask(TASK_PAYLOAD);
    expect(summary).toEqual({
      taskId: "OOLE-546",
      name: "[Mobile] [Sign Up] Title <not> enforced & skipped",
      url: "https://app.clickup.com/t/z94x8ecybd",
    });
  });

  it("summarize_task_falls_back_to_internal_id", () => {
    const summary = summarizeTask({ id: "abc123", name: "x", status: "open" });
    expect(summary.taskId).toBe("abc123");
    expect(summary.url).toBe("");
  });

  it("build_message_puts_intro_then_one_linked_line_per_task", () => {
    const second: TaskSummary = { taskId: "OOLE-547", name: "Second", url: "https://app.clickup.com/t/b" };
    const message = buildMessage([summarizeTask(TASK_PAYLOAD), second], { intro: "@dev <mới> & cũ" });
    expect(message).toBe(
      "@dev &lt;mới&gt; &amp; cũ\n" +
        '1. <a href="https://app.clickup.com/t/z94x8ecybd">OOLE-546</a> ' +
        "[Mobile] [Sign Up] Title &lt;not&gt; enforced &amp; skipped\n" +
        '2. <a href="https://app.clickup.com/t/b">OOLE-547</a> Second',
    );
  });

  it("build_message_without_url_or_intro", () => {
    const task: TaskSummary = { taskId: "OOLE-1", name: "n", url: "" };
    expect(buildMessage([task])).toBe("1. OOLE-1 n");
  });
});

describe("ExtractChatsTests", () => {
  it("extract_chats_dedupes_and_labels", () => {
    const updates = [
      { message: { chat: { id: 11, type: "private", first_name: "Khánh", last_name: "Võ", username: "khanhvo" } } },
      { message: { chat: { id: 11, type: "private", first_name: "Khánh" } } },
      { my_chat_member: { chat: { id: -22, type: "group", title: "Oole Dev" } } },
      { message: { chat: { id: "not-int" } } },
      "garbage",
    ];
    const chats = extractChats(updates);
    expect(chats.map((c) => [c.chatId, c.chatType, c.label])).toEqual([
      [11, "private", "Khánh Võ (@khanhvo)"],
      [-22, "group", "Oole Dev"],
    ]);
  });

  it("extract_topics_reads_thread_and_name", () => {
    const chat = { id: -100, type: "supergroup", title: "Oole" };
    const updates = [
      { message: { chat, text: "/start@bot" } },
      { message: { chat, is_topic_message: true, message_thread_id: 21 } },
      {
        message: {
          chat,
          is_topic_message: true,
          message_thread_id: 21,
          reply_to_message: { forum_topic_created: { name: "Bugs" } },
        },
      },
      { message: { chat, is_topic_message: true, message_thread_id: "x" } },
    ];
    const topics = extractTopics(updates);
    expect(topics.map((t) => [t.chatId, t.threadId, t.name])).toEqual([[-100, 21, "Bugs"]]);
  });
});

describe("TelegramCallTests", () => {
  it("success_returns_result_and_posts_json", async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, result: { message_id: 5 } }));
    const result = await telegramCall("123:SECRET", "sendMessage", { chat_id: "1", text: "hi" });
    expect(result).toEqual({ message_id: 5 });
    const request = calls[0]!;
    expect(request.url).toBe(SEND_MESSAGE_URL);
    expect(bodyJson(request)).toEqual({ chat_id: "1", text: "hi" });
  });

  it("http_error_uses_description_and_hides_token", async () => {
    stubFetch(
      () =>
        new Response('{"ok": false, "description": "Bad Request: chat not found"}', {
          status: 400,
          statusText: "Bad Request",
        }),
    );
    const error = await telegramCall("123:SECRET", "sendMessage", {}).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TelegramError);
    const message = (error as TelegramError).message;
    expect(message).toContain("chat not found");
    expect(message).not.toContain("SECRET");
  });

  it("not_ok_body_raises", async () => {
    stubFetch(() => jsonResponse({ ok: false, description: "nope" }));
    const error = await telegramCall("t", "getUpdates").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TelegramError);
    expect((error as TelegramError).message).toContain("nope");
  });
});

describe("RunTests", () => {
  beforeEach(() => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:SECRET");
    vi.stubEnv("TELEGRAM_CHAT_ID", "777");
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_x");
    vi.stubEnv("CLICKUP_TEAM_ID", "9018132214");
  });

  /** Stub fetch: ClickUp returns TASK_PAYLOAD; Telegram returns the given handler's response. */
  function stubServices(telegram: FetchHandler = () => jsonResponse({ ok: true, result: {} })): FetchCall[] {
    return stubFetch((call) => {
      if (call.url.startsWith(CLICKUP_PREFIX)) return jsonResponse(TASK_PAYLOAD);
      if (call.url.startsWith(TELEGRAM_PREFIX)) return telegram(call);
      throw new Error(`Unexpected request: ${call.url}`);
    });
  }

  function telegramCalls(calls: FetchCall[]): FetchCall[] {
    return calls.filter((call) => call.url.startsWith(TELEGRAM_PREFIX));
  }

  function lastTelegramCall(calls: FetchCall[]): FetchCall {
    const sent = telegramCalls(calls);
    expect(sent.length).toBeGreaterThan(0);
    return sent[sent.length - 1]!;
  }

  function lastPayload(calls: FetchCall[]): Record<string, unknown> {
    return bodyJson(lastTelegramCall(calls)) as Record<string, unknown>;
  }

  it("dry_run_prints_message_and_does_not_call_telegram", async () => {
    const calls = stubServices();
    const io = new BufferedOutput();
    const code = await run(["send", "OOLE-546", "--intro", "Hi", "--dry-run"], io);
    expect(code).toBe(0);
    expect(telegramCalls(calls)).toHaveLength(0);
    expect(io.out).toContain("OOLE-546");
    expect(io.out).not.toContain("SECRET");
  });

  it("send_posts_html_message_to_env_chat", async () => {
    const calls = stubServices(() => jsonResponse({ ok: true, result: { message_id: 9 } }));
    const code = await run(["send", "OOLE-546", "OOLE-547"], new BufferedOutput());
    expect(code).toBe(0);
    const call = lastTelegramCall(calls);
    expect(call.url).toBe(SEND_MESSAGE_URL);
    const payload = bodyJson(call) as Record<string, unknown>;
    expect(payload.chat_id).toBe("777");
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.link_preview_options).toEqual({ is_disabled: true });
    expect((payload.text as string).split("OOLE-546").length - 1).toBe(2);
    expect(payload).not.toHaveProperty("message_thread_id");
  });

  it("chat_id_flag_overrides_env", async () => {
    const calls = stubServices();
    await run(["send", "OOLE-546", "--chat-id", "42"], new BufferedOutput());
    expect(lastPayload(calls).chat_id).toBe("42");
  });

  it("thread_id_from_env_and_flag", async () => {
    vi.stubEnv("TELEGRAM_THREAD_ID", "21");
    const calls = stubServices();
    await run(["send", "OOLE-546"], new BufferedOutput());
    expect(lastPayload(calls).message_thread_id).toBe(21);
    await run(["send", "OOLE-546", "--thread-id", "7"], new BufferedOutput());
    expect(lastPayload(calls).message_thread_id).toBe(7);
  });

  it("env_ids_ignore_inline_comments", async () => {
    vi.stubEnv("TELEGRAM_THREAD_ID", "21 # topic Bugs");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-100777\t# Oole - Internal");
    const calls = stubServices();
    expect(await run(["send", "OOLE-546"], new BufferedOutput())).toBe(0);
    expect(lastPayload(calls).message_thread_id).toBe(21);
    expect(lastPayload(calls).chat_id).toBe("-100777");
  });

  it("invalid_thread_id_fails_without_sending", async () => {
    const calls = stubServices();
    expect(await run(["send", "OOLE-546", "--thread-id", "bugs"], new BufferedOutput())).toBe(1);
    expect(telegramCalls(calls)).toHaveLength(0);
  });

  it("missing_chat_id_fails_without_sending", async () => {
    vi.stubEnv("TELEGRAM_CHAT_ID", "");
    const calls = stubServices();
    const code = await run(["send", "OOLE-546"], new BufferedOutput());
    expect(code).toBe(1);
    expect(telegramCalls(calls)).toHaveLength(0);
  });

  it("missing_bot_token_fails_without_sending", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const calls = stubServices();
    expect(await run(["send", "OOLE-546"], new BufferedOutput())).toBe(1);
    expect(await run(["chats"], new BufferedOutput())).toBe(1);
    expect(telegramCalls(calls)).toHaveLength(0);
  });

  it("too_long_message_fails_without_sending", async () => {
    const calls = stubServices();
    const code = await run(["send", "OOLE-546", "--intro", "x".repeat(5000)], new BufferedOutput());
    expect(code).toBe(1);
    expect(telegramCalls(calls)).toHaveLength(0);
  });

  it("chats_lists_chat_ids", async () => {
    const updates = [{ message: { chat: { id: 11, type: "private", first_name: "Khánh" } } }];
    stubServices(() => jsonResponse({ ok: true, result: updates }));
    const io = new BufferedOutput();
    const code = await run(["chats"], io);
    expect(code).toBe(0);
    expect(io.out).toBe("11\tprivate\tKhánh\n");
  });

  it("telegram_error_returns_failure", async () => {
    stubServices(
      () => new Response('{"ok": false, "description": "Forbidden"}', { status: 403, statusText: "Forbidden" }),
    );
    expect(await run(["send", "OOLE-546"], new BufferedOutput())).toBe(1);
  });
});
