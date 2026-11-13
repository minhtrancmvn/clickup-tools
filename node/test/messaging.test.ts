import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BufferedOutput } from "../src/common.js";
import { markdownToComment, parseInline, run as runComment } from "../src/comment.js";
import { commentArgv, editCommentArgv } from "../src/mcp-server.js";
import { buildChatMessage, escapeChatMarkdown, listChannels, run as runChat } from "../src/send-chat.js";
import { bodyJson, jsonResponse, stubFetch, tempDir } from "./helpers.js";

describe("Markdown -> comment rich text", () => {
  it("parses_inline_bold_italic_code_and_links", () => {
    expect(parseInline("Use **bold**, *it*, _it2_, `x*y`, [docs](https://d.io) and <https://a.io>")).toEqual([
      { text: "Use ", attributes: {} },
      { text: "bold", attributes: { bold: true } },
      { text: ", ", attributes: {} },
      { text: "it", attributes: { italic: true } },
      { text: ", ", attributes: {} },
      { text: "it2", attributes: { italic: true } },
      { text: ", ", attributes: {} },
      { text: "x*y", attributes: { code: true } },
      { text: ", ", attributes: {} },
      { text: "docs", attributes: { link: "https://d.io" } },
      { text: " and ", attributes: {} },
      { text: "https://a.io", attributes: { link: "https://a.io" } },
    ]);
    expect(parseInline("**[bold link](https://x.y)**")).toEqual([{ text: "bold link", attributes: { bold: true, link: "https://x.y" } }]);
    expect(parseInline("snake_case_name stays")).toEqual([{ text: "snake_case_name stays", attributes: {} }]);
  });

  it("carries_block_formatting_on_line_ends", () => {
    const blocks = markdownToComment(
      ["# Update", "", "Shipped **v2**.", "- one", "  - nested", "1. first", "- [x] done", "- [ ] todo", "```", "npm test", "```"].join("\n"),
    );
    expect(blocks).toEqual([
      { text: "Update", attributes: { bold: true } },
      { text: "\n", attributes: {} },
      { text: "\n", attributes: {} },
      { text: "Shipped ", attributes: {} },
      { text: "v2", attributes: { bold: true } },
      { text: ".", attributes: {} },
      { text: "\n", attributes: {} },
      { text: "one", attributes: {} },
      { text: "\n", attributes: { list: { list: "bullet" } } },
      { text: "nested", attributes: {} },
      { text: "\n", attributes: { list: { list: "bullet" }, indent: 1 } },
      { text: "first", attributes: {} },
      { text: "\n", attributes: { list: { list: "ordered" } } },
      { text: "done", attributes: {} },
      { text: "\n", attributes: { list: { list: "checked" } } },
      { text: "todo", attributes: {} },
      { text: "\n", attributes: { list: { list: "unchecked" } } },
      { text: "npm test", attributes: {} },
      { text: "\n", attributes: { "code-block": { "code-block": "plain" } } },
    ]);
  });
});

describe("clickup-comment", () => {
  it("posts_text_as_rich_comment_to_a_custom_task", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    vi.stubEnv("CLICKUP_TEAM_ID", "9018");
    const calls = stubFetch(() => jsonResponse({ id: "458", hist_id: "h", date: 1 }));
    const io = new BufferedOutput();

    expect(await runComment(["OOLE-1", "--text", "Done **now**", "--notify-all"], io)).toBe(0);

    expect(calls[0]!.url).toBe("https://api.clickup.com/api/v2/task/OOLE-1/comment?custom_task_ids=true&team_id=9018");
    expect(bodyJson(calls[0]!)).toEqual({
      comment: [
        { text: "Done ", attributes: {} },
        { text: "now", attributes: { bold: true } },
        { text: "\n", attributes: {} },
      ],
      notify_all: true,
    });
    expect(io.out).toContain("Comment posted (id 458)");
  });

  it("posts_a_file_without_front_matter_using_its_task_id", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const file = path.join(tempDir(), "note.md");
    fs.writeFileSync(file, "---\nclickup-task-id: abc123\n---\nHello\n");
    const calls = stubFetch(() => jsonResponse({ id: "1" }));

    expect(await runComment(["--file", file], new BufferedOutput())).toBe(0);

    expect(calls[0]!.url).toBe("https://api.clickup.com/api/v2/task/abc123/comment");
    expect(bodyJson(calls[0]!)).toEqual({ comment: [{ text: "Hello", attributes: {} }, { text: "\n", attributes: {} }], notify_all: false });
  });

  it("rejects_both_sources_empty_comments_and_missing_tasks", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch(() => jsonResponse({}));

    const both = new BufferedOutput();
    expect(await runComment(["t1", "--file", "a.md", "--text", "x"], both)).toBe(2);
    expect(both.err).toContain("argument --text: not allowed with argument --file");

    const empty = new BufferedOutput();
    expect(await runComment(["t1", "--text", "   "], empty)).toBe(1);
    expect(empty.err).toContain("The comment is empty.");

    const noTask = new BufferedOutput();
    expect(await runComment(["--text", "hi"], noTask)).toBe(1);
    expect(noTask.err).toContain("No task given.");
    expect(calls).toHaveLength(0);
  });

  it("edits_a_comment_with_rich_text_and_plain_fallback", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch(() => jsonResponse({}));
    const io = new BufferedOutput();

    expect(await runComment(["--edit", "90160123", "--text", "Now on **prod**\n- one"], io)).toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://api.clickup.com/api/v2/comment/90160123");
    expect(calls[0]!.headers).toMatchObject({ Authorization: "pk_test" });
    expect(bodyJson(calls[0]!)).toEqual({
      comment_text: "Now on prod\none",
      comment: [
        { text: "Now on ", attributes: {} },
        { text: "prod", attributes: { bold: true } },
        { text: "\n", attributes: {} },
        { text: "one", attributes: {} },
        { text: "\n", attributes: { list: { list: "bullet" } } },
      ],
    });
    expect(io.out).toContain("Comment 90160123 updated");
  });

  it("edits_from_a_file_ignoring_its_task_front_matter", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const file = path.join(tempDir(), "note.md");
    fs.writeFileSync(file, "---\nclickup-task-id: OOLE-1\n---\nFixed\n");
    const calls = stubFetch(() => jsonResponse({}));

    expect(await runComment(["--edit", "77", "--file", file], new BufferedOutput())).toBe(0);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(["PUT https://api.clickup.com/api/v2/comment/77"]);
    expect(bodyJson(calls[0]!)).toMatchObject({ comment_text: "Fixed" });
  });

  it("edit_rejects_bad_ids_and_task_only_options", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch(() => jsonResponse({}));

    const badId = new BufferedOutput();
    expect(await runComment(["--edit", "12/../../task/x", "--text", "hi"], badId)).toBe(1);
    expect(badId.err).toContain("Invalid comment ID");

    const emptyId = new BufferedOutput();
    expect(await runComment(["--edit=", "--text", "hi"], emptyId)).toBe(1);
    expect(emptyId.err).toContain("Invalid comment ID");

    const withTask = new BufferedOutput();
    expect(await runComment(["t1", "--edit", "5", "--text", "hi"], withTask)).toBe(2);
    expect(withTask.err).toContain("argument TASK_OR_URL: not allowed with argument --edit");

    const withNotify = new BufferedOutput();
    expect(await runComment(["--edit", "5", "--text", "hi", "--notify-all"], withNotify)).toBe(2);
    expect(withNotify.err).toContain("argument --notify-all: not allowed with argument --edit");

    const empty = new BufferedOutput();
    expect(await runComment(["--edit", "5", "--text", "  "], empty)).toBe(1);
    expect(empty.err).toContain("The comment is empty.");
    expect(calls).toHaveLength(0);
  });

  it("edit_reports_http_errors", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch(() => jsonResponse({ err: "Comment not found", ECODE: "COMMENT_001" }, 404));
    const io = new BufferedOutput();

    expect(await runComment(["--edit", "5", "--text", "hi"], io)).toBe(1);
    expect(io.err).toContain("404");
    expect(io.out).not.toContain("updated");
  });

  it("mcp_edit_argv_passes_id_and_dash_text", async () => {
    expect(editCommentArgv({ comment_id: "5", text: "- item" })).toEqual(["--edit=5", "--text=- item"]);
    expect(editCommentArgv({ comment_id: "5", file_path: "/a.md" })).toEqual(["--edit=5", "--file", "/a.md"]);
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch(() => jsonResponse({}));
    expect(await runComment(editCommentArgv({ comment_id: "5", text: "- item" }), new BufferedOutput())).toBe(0);
    expect(bodyJson(calls[0]!)).toMatchObject({ comment_text: "item", comment: [{ text: "item" }, { text: "\n", attributes: { list: { list: "bullet" } } }] });
  });

  it("mcp_argv_passes_text_that_starts_with_a_dash", async () => {
    expect(commentArgv({ task_id: "t1", text: "- item" })).toEqual(["t1", "--text=- item"]);
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch(() => jsonResponse({ id: "1" }));
    expect(await runComment(commentArgv({ task_id: "t1", text: "- item" }), new BufferedOutput())).toBe(0);
    expect(bodyJson(calls[0]!)).toMatchObject({ comment: [{ text: "item" }, { text: "\n", attributes: { list: { list: "bullet" } } }] });
  });
});

describe("clickup-send-chat", () => {
  it("builds_a_markdown_message_with_escaped_names", () => {
    expect(escapeChatMarkdown("a_b *c* [d]")).toBe("a\\_b \\*c\\* \\[d\\]");
    expect(
      buildChatMessage(
        [
          { taskId: "OOLE-1", name: "Fix *login*", url: "https://app.clickup.com/t/86a" },
          { taskId: "OOLE-2", name: "No url", url: "" },
        ],
        { intro: "@dev please check" },
      ),
    ).toBe("@dev please check\n\n1. [OOLE-1](https://app.clickup.com/t/86a) Fix \\*login\\*\n2. OOLE-2 No url");
  });

  it("lists_channels_across_pages", async () => {
    const calls = stubFetch((call) =>
      call.url.includes("cursor=")
        ? jsonResponse({ data: [{ id: "c2", name: "", type: "DM" }] })
        : jsonResponse({ data: [{ id: "c1", name: "general", type: "CHANNEL" }], next_cursor: "n1" }),
    );

    expect(await listChannels("9018", "pk")).toEqual([
      { id: "c1", type: "CHANNEL", name: "general" },
      { id: "c2", type: "DM", name: "(direct message)" },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.clickup.com/api/v3/workspaces/9018/chat/channels?limit=100",
      "https://api.clickup.com/api/v3/workspaces/9018/chat/channels?limit=100&cursor=n1",
    ]);
  });

  it("sends_the_task_list_to_the_channel", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    vi.stubEnv("CLICKUP_TEAM_ID", "9018");
    vi.stubEnv("CLICKUP_CHAT_CHANNEL_ID", "c1  # team channel");
    const calls = stubFetch((call) =>
      call.method === "POST" ? jsonResponse({ id: "m1" }) : jsonResponse({ id: "86a", custom_id: "OOLE-1", name: "Fix", url: "https://u" }),
    );
    const io = new BufferedOutput();

    expect(await runChat(["send", "OOLE-1", "--intro", "Today"], io)).toBe(0);

    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe("https://api.clickup.com/api/v3/workspaces/9018/chat/channels/c1/messages");
    expect(bodyJson(post)).toEqual({ type: "message", content: "Today\n\n1. [OOLE-1](https://u) Fix", content_format: "text/md" });
    expect(io.out).toContain("Sent 1 task(s) to channel c1 (message m1)");
  });

  it("dry_run_prints_and_errors_are_clear", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch(() => jsonResponse({ id: "86a", name: "Fix", url: "https://u" }));

    const dry = new BufferedOutput();
    expect(await runChat(["send", "86a", "--dry-run"], dry)).toBe(0);
    expect(dry.out).toBe("1. [86a](https://u) Fix\n");

    const noChannel = new BufferedOutput();
    expect(await runChat(["send", "86a"], noChannel)).toBe(1);
    expect(noChannel.err).toContain("No channel ID.");

    const noTeam = new BufferedOutput();
    expect(await runChat(["channels"], noTeam)).toBe(1);
    expect(noTeam.err).toContain("CLICKUP_TEAM_ID is not set.");

    const usage = new BufferedOutput();
    expect(await runChat(["send"], usage)).toBe(2);
    expect(usage.err).toContain("clickup-send-chat send: error: the following arguments are required: TASK_OR_URL");
  });
});
