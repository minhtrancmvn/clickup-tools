import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BufferedOutput, HttpError, httpRequest, MAX_RATE_LIMIT_WAIT_MS, rateLimitDelayMs, timers } from "../src/common.js";
import { readTaskArgv } from "../src/mcp-server.js";
import { getTaskComments, run as runReadTask } from "../src/read-task.js";
import { run as runUpdatePage } from "../src/update-page.js";
import {
  parseTaskDate,
  parseTaskFields,
  parseTimeEstimate,
  prepareMarkdownTaskContent,
  run as runUpdateTask,
  taskDestination,
} from "../src/update-task.js";
import { bodyJson, jsonResponse, stubFetch, tempDir } from "./helpers.js";

const TASK_URL = "https://api.clickup.com/api/v2/task/abc123?include_subtasks=true&include_markdown_description=true";

function rateLimited(headers: Record<string, string>): Response {
  return new Response('{"err":"Rate limit reached"}', { status: 429, headers });
}

function writeMarkdown(content: string): string {
  const file = path.join(tempDir(), "task.md");
  fs.writeFileSync(file, content);
  return file;
}

describe("HTTP 429 handling", () => {
  it("waits_for_retry_after_then_retries_with_the_same_body", async () => {
    const sleep = vi.spyOn(timers, "sleep").mockResolvedValue();
    let attempt = 0;
    const calls = stubFetch(() => (attempt++ === 0 ? rateLimited({ "Retry-After": "2" }) : new Response("ok")));

    await expect(httpRequest("https://api.clickup.com/x", { method: "POST", body: '{"a":1}' })).resolves.toBe("ok");

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls.map((call) => [call.method, call.body])).toEqual([
      ["POST", '{"a":1}'],
      ["POST", '{"a":1}'],
    ]);
  });

  it("uses_x_ratelimit_reset_seconds_when_no_retry_after", () => {
    const headers = new Headers({ "X-RateLimit-Reset": "1794400874" });
    expect(rateLimitDelayMs(headers, 1794400870_000)).toBe(4_500);
    expect(rateLimitDelayMs(new Headers({ "X-RateLimit-Reset": "1794400874000" }), 1794400873_000)).toBe(1_500);
    expect(rateLimitDelayMs(new Headers())).toBeNull();
  });

  it("fails_fast_when_the_reset_is_too_far_away", async () => {
    const sleep = vi.spyOn(timers, "sleep").mockResolvedValue();
    vi.spyOn(timers, "now").mockReturnValue(0);
    stubFetch(() => rateLimited({ "X-RateLimit-Reset": String((MAX_RATE_LIMIT_WAIT_MS + 5_000) / 1000) }));

    const error = await httpRequest("https://api.clickup.com/x").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe(429);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives_up_after_two_retries", async () => {
    vi.spyOn(timers, "sleep").mockResolvedValue();
    const calls = stubFetch(() => rateLimited({ "Retry-After": "1" }));

    await expect(httpRequest("https://api.clickup.com/x")).rejects.toMatchObject({ code: 429 });
    expect(calls).toHaveLength(3);
  });
});

describe("read-task: markdown description and incomplete subtask trees", () => {
  it("prints_the_markdown_description", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch((call) =>
      call.url.endsWith("/time")
        ? jsonResponse({ data: [] })
        : jsonResponse({ name: "Task", description: "Source\nlink", markdown_description: "## Source\n- [link](https://x.y)" }),
    );
    const io = new BufferedOutput();

    expect(await runReadTask(["abc123", "--json"], io)).toBe(0);

    expect(calls[0]!.url).toBe(TASK_URL);
    expect(JSON.parse(io.out).description).toBe("## Source\n- [link](https://x.y)");
  });

  it("flags_subtasks_whose_children_could_not_be_loaded", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch((call) => {
      if (call.url.endsWith("/time")) return jsonResponse({ data: [] });
      if (call.url.includes("/task/child1?")) return new Response("boom", { status: 500 });
      return jsonResponse({ name: "Parent", subtasks: [{ id: "child1", name: "Child", status: { status: "open" } }] });
    });

    const json = new BufferedOutput();
    expect(await runReadTask(["abc123", "--json"], json)).toBe(0);
    const data = JSON.parse(json.out);
    expect(data.subtasks_incomplete).toBe(true);
    expect(data.subtasks[0]).toMatchObject({ task_id: "child1", subtasks: [], subtasks_note: "Unavailable (API error 500)" });

    const text = new BufferedOutput();
    await runReadTask(["abc123"], text);
    expect(text.out).toContain("- child1  Child  (open)  [subtasks unavailable (api error 500)]");
  });

  it("omits_incomplete_flags_when_the_tree_loaded", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch((call) => {
      if (call.url.endsWith("/time")) return jsonResponse({ data: [] });
      if (call.url.includes("/task/child1?")) return jsonResponse({ subtasks: [] });
      return jsonResponse({ name: "Parent", subtasks: [{ id: "child1", name: "Child" }] });
    });
    const io = new BufferedOutput();

    await runReadTask(["abc123", "--json"], io);

    const data = JSON.parse(io.out);
    expect(data).not.toHaveProperty("subtasks_incomplete");
    expect(data.subtasks[0]).not.toHaveProperty("subtasks_note");
  });
});

describe("read-task: comment paging and replies", () => {
  const page = (from: number, count: number) => ({
    comments: Array.from({ length: count }, (_, index) => ({
      id: `c${from + index}`,
      comment_text: `comment ${from + index}`,
      date: String(2_000_000 - (from + index) * 1000),
      user: { username: "Ann" },
      reply_count: "0",
    })),
  });

  it("pages_with_start_and_start_id_until_the_limit", async () => {
    const calls = stubFetch((call) => (call.url.includes("start_id=") ? jsonResponse(page(26, 25)) : jsonResponse(page(1, 25))));

    const comments = await getTaskComments(taskDestination("OOLE-1", "9", true), "pk", { limit: 30 });

    expect(comments.map((comment) => comment.id)).toEqual(Array.from({ length: 30 }, (_, index) => `c${index + 1}`));
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.clickup.com/api/v2/task/OOLE-1/comment?custom_task_ids=true&team_id=9",
      `https://api.clickup.com/api/v2/task/OOLE-1/comment?custom_task_ids=true&team_id=9&start=${2_000_000 - 25_000}&start_id=c25`,
    ]);
  });

  it("stops_after_a_short_page_and_makes_one_request_for_small_limits", async () => {
    const short = stubFetch(() => jsonResponse(page(1, 7)));
    expect(await getTaskComments(taskDestination("abc"), "pk", { limit: 100 })).toHaveLength(7);
    expect(short).toHaveLength(1);

    const small = stubFetch(() => jsonResponse(page(1, 25)));
    expect(await getTaskComments(taskDestination("abc"), "pk", { limit: 20 })).toHaveLength(20);
    expect(small).toHaveLength(1);
  });

  it("includes_reply_counts_and_threaded_replies_oldest_first", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/time")) return jsonResponse({ data: [] });
      if (call.url.includes("/comment/c1/reply")) {
        return jsonResponse({
          comments: [
            { id: "r2", comment_text: "second", date: "1700000200000", user: { username: "Bo" } },
            { id: "r1", comment_text: "first", date: "1700000100000", user: { username: "Cy" } },
          ],
        });
      }
      if (call.url.includes("/comment")) {
        return jsonResponse({
          comments: [
            { id: "c1", comment_text: "question", date: "1700000000000", user: { username: "Ann" }, reply_count: "2" },
            { id: "c2", comment_text: "note", date: "1699999000000", user: { username: "Ann" }, reply_count: "0" },
          ],
        });
      }
      return jsonResponse({ name: "Task" });
    });

    const json = new BufferedOutput();
    expect(await runReadTask(["abc123", "--json", "--include-replies"], json)).toBe(0);
    const comments = JSON.parse(json.out).comments;
    expect(comments[0]).toMatchObject({ id: "c1", reply_count: 2 });
    expect(comments[0].replies.map((reply: { id: string }) => reply.id)).toEqual(["r1", "r2"]);
    expect(comments[1]).toMatchObject({ id: "c2", reply_count: 0, replies: [] });
    // Only c1 has replies, so only one reply request.
    expect(calls.filter((call) => call.url.includes("/reply"))).toHaveLength(1);

    const text = new BufferedOutput();
    await runReadTask(["abc123", "--include-replies"], text);
    expect(text.out).toContain("Ann  question  [2 replies]");
    expect(text.out).toMatch(/> 2023-11-14 22:15 UTC {2}Cy {2}first\n {6}> 2023-11-14 22:16 UTC {2}Bo {2}second/);
  });

  it("notes_reply_failures_and_omits_replies_unless_requested", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch((call) => {
      if (call.url.endsWith("/time")) return jsonResponse({ data: [] });
      if (call.url.includes("/reply")) return new Response("{}", { status: 403 });
      if (call.url.includes("/comment")) {
        return jsonResponse({ comments: [{ id: "c1", comment_text: "q", date: "1", user: {}, reply_count: "1" }] });
      }
      return jsonResponse({ name: "Task" });
    });

    const withReplies = new BufferedOutput();
    await runReadTask(["abc123", "--json", "--include-replies"], withReplies);
    expect(JSON.parse(withReplies.out).comments[0]).toMatchObject({ replies: [], replies_note: "Unavailable (API error 403)" });

    const without = new BufferedOutput();
    await runReadTask(["abc123", "--json", "--include-comments"], without);
    expect(JSON.parse(without.out).comments[0]).toEqual(expect.not.objectContaining({ replies: expect.anything() }));
  });

  it("mcp_argv_requests_replies", () => {
    expect(readTaskArgv({ include_replies: true })).toEqual(["--json", "--include-comments", "--comment-limit", "20", "--include-replies"]);
  });
});

describe("update-task: task fields from front matter", () => {
  it("parses_priorities_points_estimates_and_dates", () => {
    const { fields, sources } = parseTaskFields({
      status: "in progress",
      priority: "High",
      points: "1.5",
      time_estimate: "1h 30m",
      start_date: "2026-11-20",
      due_date: "2026-11-25T17:00:00Z",
      outcome: "ignored here",
    });

    expect(fields).toEqual({
      status: "in progress",
      priority: 2,
      points: 1.5,
      time_estimate: 5_400_000,
      start_date: new Date(2026, 10, 20).getTime(),
      start_date_time: false,
      due_date: Date.parse("2026-11-25T17:00:00Z"),
      due_date_time: true,
    });
    expect(Object.keys(sources)).toEqual(["status", "priority", "points", "time_estimate", "start_date", "due_date"]);
    expect(parseTaskFields({ priority: "none" }).fields).toEqual({ priority: null });
    expect(parseTaskFields({ status: "" }).fields).toEqual({});
  });

  it("parses_durations_and_local_datetimes", () => {
    expect(parseTimeEstimate("90m")).toBe(5_400_000);
    expect(parseTimeEstimate("1.5h")).toBe(5_400_000);
    expect(parseTimeEstimate("2h")).toBe(7_200_000);
    expect(parseTaskDate("due_date", "2026-11-20 14:05")).toEqual({ ms: new Date(2026, 10, 20, 14, 5).getTime(), hasTime: true });
  });

  it("rejects_invalid_values_with_clear_messages", () => {
    expect(() => parseTaskFields({ priority: "5" })).toThrow("priority must be urgent, high, normal, low, none or 1-4; got '5'");
    expect(() => parseTaskFields({ points: "lots" })).toThrow("points must be a number; got 'lots'");
    expect(() => parseTimeEstimate("90")).toThrow('time_estimate must use hours and/or minutes, e.g. "2h", "45m" or "1h 30m"; got \'90\'');
    expect(() => parseTaskDate("due_date", "2026-13-01")).toThrow("due_date must be YYYY-MM-DD");
    expect(() => parseTaskDate("start_date", "tomorrow")).toThrow("start_date must be YYYY-MM-DD");
  });

  it("sends_fields_with_the_description_update", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const markdown = writeMarkdown("---\nclickup-task-id: abc123\nstatus: review\npriority: urgent\n---\n# Title\n\nBody\n");
    const calls = stubFetch(() => jsonResponse({}));
    const io = new BufferedOutput();

    expect(await runUpdateTask([markdown, "--no-rich-links"], io)).toBe(0);

    expect(bodyJson(calls[0]!)).toEqual({ markdown_content: "Body\n", name: "Title", status: "review", priority: 1 });
    expect(io.out).toContain("Fields      : status=review  priority=urgent");
  });

  it("reports_invalid_fields_without_calling_the_api", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const markdown = writeMarkdown("---\nclickup-task-id: abc123\ndue_date: someday\n---\nBody\n");
    const calls = stubFetch(() => jsonResponse({}));
    const io = new BufferedOutput();

    expect(await runUpdateTask([markdown], io)).toBe(1);
    expect(io.err).toContain("due_date must be YYYY-MM-DD");
    expect(calls).toHaveLength(0);
  });
});

describe("update-task: reuse attachments already on the task", () => {
  function setup(attachments: unknown[]) {
    const markdown = writeMarkdown("---\nclickup-task-id: abc123\n---\n![flow](flow.gif)\n");
    fs.writeFileSync(path.join(path.dirname(markdown), "flow.gif"), "gif");
    const calls = stubFetch((call) =>
      call.method === "GET" ? jsonResponse({ id: "abc123", attachments }) : jsonResponse({ url: "https://cdn/new.gif" }),
    );
    return { markdown, calls };
  }

  it("reuses_a_matching_name_and_size_without_uploading", async () => {
    const { markdown, calls } = setup([{ title: "flow.gif", size: 3, url: "https://cdn/existing.gif" }]);

    const prepared = await prepareMarkdownTaskContent(markdown, "pk", taskDestination("abc123"), { richLinks: false });

    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(prepared.content).toBe("![flow](<https://cdn/existing.gif>)\n");
    expect([...prepared.reusedAttachments.values()]).toEqual(["https://cdn/existing.gif"]);
    expect(prepared.uploadedAttachments.size).toBe(0);
  });

  it("uploads_when_size_differs_is_missing_or_the_match_was_deleted", async () => {
    for (const attachments of [
      [{ title: "flow.gif", size: 999, url: "https://cdn/other.gif" }],
      [{ title: "flow.gif", url: "https://cdn/nosize.gif" }],
      [{ title: "flow.gif", size: "3", url: "https://cdn/deleted.gif", deleted: true }],
    ]) {
      const { markdown, calls } = setup(attachments);
      const prepared = await prepareMarkdownTaskContent(markdown, "pk", taskDestination("abc123"), { richLinks: false });
      expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
      expect(prepared.content).toBe("![flow](<https://cdn/new.gif>)\n");
    }
  });

  it("run_reports_reused_attachments", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const { markdown } = setup([{ title: "flow.gif", size: "3", url: "https://cdn/existing.gif" }]);
    const io = new BufferedOutput();

    expect(await runUpdateTask([markdown, "--no-rich-links"], io)).toBe(0);
    expect(io.out).toContain("Attachments : uploaded=0  reused=1");
    expect(io.out).toContain("flow.gif -> https://cdn/existing.gif (already attached)");
  });
});

describe("update-page: subtitle", () => {
  it("sends_sub_title_from_front_matter", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const markdown = path.join(tempDir(), "page.md");
    fs.writeFileSync(markdown, "---\nclickup-page: https://app.clickup.com/1/v/dc/d/p\nsubtitle: 'Draft v2'\n---\n# Page\n\nBody\n");
    const calls = stubFetch(() => new Response(""));
    const io = new BufferedOutput();

    expect(await runUpdatePage([markdown, "--no-open"], io)).toBe(0);
    expect(bodyJson(calls[0]!)).toEqual({
      content: "Body\n",
      content_format: "text/md",
      content_edit_mode: "replace",
      name: "Page",
      sub_title: "Draft v2",
    });
    expect(io.out).toContain("Subtitle: Draft v2");
  });
});
