import { describe, expect, it, vi } from "vitest";

import { BufferedOutput } from "../src/common.js";
import { formatToolResult, readTaskArgv } from "../src/mcp-server.js";
import {
  countSubtasks,
  detailsToDict,
  expandSubtasks,
  extractComments,
  extractOutcomeValue,
  extractSubtasks,
  extractTags,
  extractTaskDetails,
  extractTimeEntries,
  formatDurationMs,
  formatEpochMs,
  getTaskComments,
  parseReadTaskArgs,
  parseTaskIdentifier,
  renderTaskDetails,
  renderTaskJson,
  resolveDestination,
  run,
  type Comment,
  type Subtask,
  type TimeEntry,
} from "../src/read-task.js";
import { taskDestination } from "../src/update-task.js";
import { jsonResponse, networkFailure, stubFetch, type FetchCall } from "./helpers.js";

const TASK_URL = "https://api.clickup.com/api/v2/task/abc123?include_subtasks=true&include_markdown_description=true";

describe("ClickUpReadTaskTests", () => {
  it("parse_task_identifier_from_url_with_team_id", () => {
    expect(parseTaskIdentifier("https://app.clickup.com/t/1234567890/OOLE-523")).toEqual(["OOLE-523", "1234567890"]);
  });

  it("parse_task_identifier_from_plain_id", () => {
    expect(parseTaskIdentifier("abc123")).toEqual(["abc123", ""]);
  });

  it("resolve_destination_uses_team_id_from_url_for_custom_id", () => {
    const destination = resolveDestination("https://app.clickup.com/t/1234567890/OOLE-523");

    expect(destination).toEqual(taskDestination("OOLE-523", "1234567890", true));
  });

  it("resolve_destination_requires_team_id_for_custom_id", () => {
    expect(() => resolveDestination("OOLE-523")).toThrow();
  });

  it("resolve_destination_supports_internal_task_id_without_team", () => {
    const destination = resolveDestination("abc123");

    expect(destination).toEqual(taskDestination("abc123", "", false));
  });

  it("format_duration_ms", () => {
    expect(formatDurationMs(null)).toBe("Not set");
    expect(formatDurationMs(0)).toBe("0m (0 ms)");
    expect(formatDurationMs(5_400_000)).toBe("1h 30m (5,400,000 ms)");
    expect(formatDurationMs(45_000)).toBe("45s (45,000 ms)");
  });

  it("extract_tags", () => {
    expect(extractTags({ tags: [{ name: "bug" }, { name: "client" }, "urgent"] })).toEqual(["bug", "client", "urgent"]);
  });

  it("extract_outcome_value_by_name", () => {
    const [available, value] = extractOutcomeValue(
      { custom_fields: [{ id: "field-1", name: "Outcome", value: "Fixed and deployed" }] },
      { outcomeFieldId: "" },
    );

    expect(available).toBe(true);
    expect(value).toBe("Fixed and deployed");
  });

  it("extract_outcome_value_by_configured_id_with_dropdown_option", () => {
    const [available, value] = extractOutcomeValue(
      {
        custom_fields: [
          {
            id: "outcome-field",
            name: "Result",
            value: "option-1",
            type_config: { options: [{ id: "option-1", name: "Done" }] },
          },
        ],
      },
      { outcomeFieldId: "outcome-field" },
    );

    expect(available).toBe(true);
    expect(value).toBe("Done");
  });

  it("extract_outcome_value_absent", () => {
    const [available, value] = extractOutcomeValue({ custom_fields: [] }, { outcomeFieldId: "outcome-field" });

    expect(available).toBe(false);
    expect(value).toBe("");
  });

  it("extract_task_details_and_render_requested_fields", () => {
    const details = extractTaskDetails(
      {
        name: "Task Title",
        status: { status: "in progress" },
        markdown_description: "## Details\nBody",
        time_estimate: 3_600_000,
        time_spent: 1_800_000,
        tags: [{ name: "bug" }],
        custom_fields: [{ name: "Outcome", value: "Shipped" }],
      },
      { outcomeFieldId: "" },
    );
    const rendered = renderTaskDetails(details);

    expect(rendered).toContain("Title: Task Title");
    expect(rendered).toContain("Status: in progress");
    expect(rendered).toContain("## Details\nBody");
    expect(rendered).toContain("Time estimate: 1h (3,600,000 ms)");
    expect(rendered).toContain("Tracked time: 30m (1,800,000 ms)");
    expect(rendered).toContain("Tags: bug");
    expect(rendered).toContain("Outcome:\nShipped");
  });

  it("extract_task_checklists_preserves_ids_completion_and_item_order", () => {
    const details = extractTaskDetails(
      {
        name: "Task",
        checklists: [
          {
            id: "check-2",
            name: "Release",
            orderindex: 2,
            items: [
              { id: "item-2", name: "Ship", orderindex: 2, resolved: false, parent: "item-1", children: [] },
              { id: "item-1", name: "Review", orderindex: 1, resolved: true, parent: null, children: ["item-2"] },
            ],
          },
          { id: "check-1", name: "Prepare", orderindex: 1, items: [] },
        ],
      },
      { outcomeFieldId: "" },
    );

    const data = detailsToDict(details) as { checklists: Array<{ name: string }> };
    expect(data.checklists.map((checklist) => checklist.name)).toEqual(["Prepare", "Release"]);
    expect(data.checklists[1]).toEqual({
      id: "check-2",
      name: "Release",
      items: [
        { id: "item-1", name: "Review", resolved: true, parent: null, children: ["item-2"] },
        { id: "item-2", name: "Ship", resolved: false, parent: "item-1", children: [] },
      ],
    });
  });

  it("render_task_checklists_shows_nested_completion", () => {
    const details = extractTaskDetails(
      {
        name: "Task",
        checklists: [
          {
            id: "check-1",
            name: "Release",
            items: [
              { id: "child", name: "Ship", resolved: false, parent: "root" },
              { id: "root", name: "Review", resolved: true, parent: null },
            ],
          },
        ],
      },
      { outcomeFieldId: "" },
    );

    expect(renderTaskDetails(details)).toContain("Checklists: 1\n  Release\n    [x] Review\n      [ ] Ship");
  });

  it("render_task_checklists_keeps_items_with_missing_or_cyclic_parents", () => {
    const details = extractTaskDetails(
      {
        checklists: [
          {
            name: "Review",
            items: [
              { id: "orphan", name: "Orphan", parent: "missing", resolved: false },
              { id: "cycle-a", name: "Cycle A", parent: "cycle-b", resolved: false },
              { id: "cycle-b", name: "Cycle B", parent: "cycle-a", resolved: true },
            ],
          },
        ],
      },
      { outcomeFieldId: "" },
    );

    const rendered = renderTaskDetails(details);
    expect(rendered.split("Orphan").length - 1).toBe(1);
    expect(rendered.split("Cycle A").length - 1).toBe(1);
    expect(rendered.split("Cycle B").length - 1).toBe(1);
  });

  it("task_checklists_default_to_empty_for_missing_or_malformed_payload", () => {
    const cases: Array<[unknown, unknown[]]> = [
      [{ name: "Task" }, []],
      [{ name: "Task", checklists: null }, []],
      [
        { name: "Task", checklists: [null, { name: "Empty", items: "invalid" }] },
        [{ id: "", name: "Empty", items: [] }],
      ],
    ];
    for (const [payload, expected] of cases) {
      const details = extractTaskDetails(payload, { outcomeFieldId: "" });
      expect((detailsToDict(details) as { checklists: unknown }).checklists).toEqual(expected);
      expect(renderTaskDetails(details)).toContain(`Checklists: ${expected.length}`);
    }
  });

  it("comments_default_to_disabled", () => {
    const io = new BufferedOutput();
    const args = parseReadTaskArgs([], io);

    expect(args).toMatchObject({ includeComments: false, commentLimit: 20 });
  });

  it("comment_limit_rejects_values_above_max", async () => {
    const io = new BufferedOutput();
    const code = await run(["--comment-limit", "101"], io);

    expect(code).toBe(2);
    expect(io.err).toContain("comment limit must be between 1 and 100");
  });

  it("get_task_comments_uses_custom_task_query_and_limit", async () => {
    const destination = taskDestination("OOLE-523", "1234567890", true);
    const calls = stubFetch(() =>
      jsonResponse({ comments: Array.from({ length: 25 }, (_, index) => ({ id: String(index) })) }),
    );

    const comments = await getTaskComments(destination, "pk_test", { limit: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.clickup.com/api/v2/task/OOLE-523/comment?custom_task_ids=true&team_id=1234567890",
    );
    expect(calls[0]!.headers.Authorization).toBe("pk_test");
    expect(comments.map((comment) => comment.id)).toEqual(["0", "1"]);
  });

  it("extract_comments_prefers_plain_text_and_falls_back_to_rich_text", () => {
    const comments = extractComments([
      {
        id: "458",
        comment_text: "First comment",
        comment: [{ text: "Ignored rich text" }],
        user: { username: "Alice" },
        date: "1568036964079",
        resolved: false,
      },
      {
        id: "459",
        comment: [{ text: "Rich " }, { text: "comment" }],
        user: { id: 42 },
        date: "1568037964079",
        resolved: true,
      },
    ]);

    expect(comments[0]!.text).toBe("First comment");
    expect(comments[0]!.user).toBe("Alice");
    expect(comments[0]!.dateMs).toBe(1568036964079);
    expect(comments[1]!.text).toBe("Rich comment");
    expect(comments[1]!.user).toBe("User 42");
    expect(comments[1]!.resolved).toBe(true);
  });

  it("requested_comments_appear_in_text_and_json", () => {
    let details = extractTaskDetails({ name: "Task", status: "open", custom_fields: [] }, { outcomeFieldId: "" });
    const comment: Comment = {
      commentId: "458",
      user: "Alice",
      date: "2019-09-09 09:49 UTC",
      dateMs: 1568036964079,
      text: "First comment",
      resolved: false,
      replyCount: 0,
      replies: [],
      repliesNote: "",
    };
    details = { ...details, comments: [comment], commentsIncluded: true };

    const rendered = renderTaskDetails(details);
    const data = detailsToDict(details);

    expect(rendered).toContain("Comments: 1");
    expect(rendered).toContain("Alice  First comment");
    expect(data.comments).toEqual([
      {
        id: "458",
        user: "Alice",
        date: "2019-09-09 09:49 UTC",
        date_ms: 1568036964079,
        text: "First comment",
        resolved: false,
        reply_count: 0,
      },
    ]);
  });

  it("comments_are_absent_when_not_requested", () => {
    const details = extractTaskDetails({ name: "Task", status: "open", custom_fields: [] }, { outcomeFieldId: "" });

    expect(renderTaskDetails(details)).not.toContain("Comments:");
    expect(detailsToDict(details)).not.toHaveProperty("comments");
    expect(detailsToDict(details)).not.toHaveProperty("comments_note");
  });

  it("render_task_json_is_ai_ready", () => {
    let details = extractTaskDetails(
      {
        name: "Task Title",
        status: { status: "in progress" },
        markdown_description: "Body",
        time_estimate: 3_600_000,
        time_spent: 1_800_000,
        tags: [{ name: "bug" }],
        custom_fields: [{ name: "Outcome", value: "Shipped" }],
      },
      { outcomeFieldId: "" },
    );
    const entry: TimeEntry = {
      user: "Alice",
      date: "2023-11-14 22:13 UTC",
      duration: "30m (1,800,000 ms)",
      startMs: 1700000000000,
      tags: ["review"],
    };
    details = { ...details, timeEntries: [entry] };

    const data = JSON.parse(renderTaskJson(details, { url: "https://app.clickup.com/t/9018/OOLE-1" }));

    expect(data.title).toBe("Task Title");
    expect(data.status).toBe("in progress");
    expect(data.tracked_time).toBe("30m (1,800,000 ms)");
    expect(data.tags).toEqual(["bug"]);
    expect(data.outcome).toBe("Shipped");
    expect(data.url).toBe("https://app.clickup.com/t/9018/OOLE-1");
    expect(data.time_entries).toHaveLength(1);
    expect(data.time_entries[0].user).toBe("Alice");
    expect(data.time_entries[0].start_ms).toBe(1700000000000);
    expect(data.time_entries[0].tags).toEqual(["review"]);
  });

  it("details_to_dict_outcome_none_when_absent", () => {
    const details = extractTaskDetails(
      { name: "T", status: "open", custom_fields: [] },
      { outcomeFieldId: "missing" },
    );
    const data = detailsToDict(details);

    expect(data.outcome).toBeNull();
    expect(data.time_entries).toEqual([]);
    expect(data.has_subtasks).toBe(false);
    expect(data.subtasks).toEqual([]);
  });

  it("extract_subtasks", () => {
    const subtasks = extractSubtasks({
      subtasks: [
        { id: "86ev1952v", custom_id: "AITAI-225", name: "Reproduce issue", status: { status: "live review" } },
        { id: "86ev5w1f3", name: "Fix it", status: { status: "uat review" } },
      ],
    });

    expect(subtasks).toHaveLength(2);
    expect(subtasks[0]!.customId).toBe("AITAI-225");
    expect(subtasks[0]!.name).toBe("Reproduce issue");
    expect(subtasks[0]!.status).toBe("live review");
    expect(subtasks[1]!.customId).toBe("");
  });

  it("extract_subtasks_absent", () => {
    expect(extractSubtasks({ name: "T" })).toEqual([]);
  });

  it("render_and_json_include_subtasks", () => {
    const details = extractTaskDetails(
      {
        name: "Parent",
        status: { status: "open" },
        description: "Body",
        custom_fields: [],
        subtasks: [{ id: "86abc", custom_id: "AITAI-225", name: "Child", status: { status: "open" } }],
      },
      { outcomeFieldId: "" },
    );

    const rendered = renderTaskDetails(details);
    expect(rendered).toContain("Subtasks: 1");
    expect(rendered).toContain("AITAI-225  Child  (open)");

    const data = JSON.parse(renderTaskJson(details));
    expect(data.has_subtasks).toBe(true);
    expect(data.subtasks).toHaveLength(1);
    expect(data.subtasks[0].custom_id).toBe("AITAI-225");
    expect(data.subtasks[0].task_id).toBe("86abc");
    expect(data.subtasks[0].status).toBe("open");
  });

  it("expand_subtasks_recurses_until_leaves", async () => {
    // Tree: A -> (B -> D), C. expand_subtasks fetches each node's children.
    const tree: Record<string, unknown[]> = {
      A: [
        { id: "B", custom_id: "T-B", name: "B", status: { status: "open" } },
        { id: "C", custom_id: "T-C", name: "C", status: { status: "open" } },
      ],
      B: [{ id: "D", custom_id: "T-D", name: "D", status: { status: "open" } }],
      C: [],
      D: [],
    };
    const fetched: string[] = [];
    stubFetch((call) => {
      const taskId = /\/task\/([^/?]+)\?include_subtasks=true$/.exec(call.url)![1]!;
      fetched.push(taskId);
      return jsonResponse({ subtasks: tree[taskId] ?? [] });
    });

    const roots = extractSubtasks({ subtasks: tree.A });
    const expanded = await expandSubtasks(roots, "pk_test");

    expect([...fetched].sort()).toEqual(["B", "C", "D"]);
    const byId = new Map<string, Subtask>(expanded.map((s) => [s.taskId, s]));
    expect(byId.get("B")!.subtasks).toHaveLength(1);
    expect(byId.get("B")!.subtasks[0]!.taskId).toBe("D");
    expect(byId.get("B")!.subtasks[0]!.subtasks).toEqual([]);
    expect(byId.get("C")!.subtasks).toEqual([]);
    expect(countSubtasks(expanded)).toBe(3);
  });

  it("expand_subtasks_guards_against_cycles", async () => {
    // A points to B, B points back to A. Visited set must stop the loop.
    const tree: Record<string, unknown[]> = {
      A: [{ id: "B", name: "B", status: { status: "open" } }],
      B: [{ id: "A", name: "A", status: { status: "open" } }],
    };
    stubFetch((call) => {
      const taskId = /\/task\/([^/?]+)\?include_subtasks=true$/.exec(call.url)![1]!;
      return jsonResponse({ subtasks: tree[taskId] ?? [] });
    });

    const roots = extractSubtasks({ subtasks: tree.A });
    const expanded = await expandSubtasks(roots, "pk_test");

    // B -> A -> B: the third B is already visited so recursion stops (no infinite loop).
    expect(expanded[0]!.taskId).toBe("B");
    expect(expanded[0]!.subtasks[0]!.taskId).toBe("A");
    expect(expanded[0]!.subtasks[0]!.subtasks[0]!.taskId).toBe("B");
    expect(expanded[0]!.subtasks[0]!.subtasks[0]!.subtasks).toEqual([]);
  });

  it("render_nested_subtasks_indented", () => {
    let details = extractTaskDetails(
      { name: "Parent", status: { status: "open" }, custom_fields: [], subtasks: [] },
      { outcomeFieldId: "" },
    );
    details = {
      ...details,
      subtasks: [
        {
          taskId: "B",
          customId: "T-B",
          name: "B",
          status: "open",
          subtasks: [{ taskId: "D", customId: "T-D", name: "D", status: "open", subtasks: [], subtasksNote: "" }],
          subtasksNote: "",
        },
      ],
    };

    const rendered = renderTaskDetails(details);
    expect(rendered).toContain("Subtasks: 2");
    expect(rendered).toContain("  - T-B  B  (open)");
    expect(rendered).toContain("    - T-D  D  (open)");

    const data = JSON.parse(renderTaskJson(details));
    expect(data.subtask_count).toBe(2);
    expect(data.subtasks[0].subtasks[0].custom_id).toBe("T-D");
  });

  it("run_json_outputs_parseable_json", async () => {
    const taskPayload = {
      id: "abc123",
      name: "JSON Task",
      status: { status: "open" },
      description: "Body",
      time_estimate: null,
      time_spent: 1_800_000,
      tags: [],
      custom_fields: [],
      checklists: [
        {
          id: "check-1",
          name: "Release",
          items: [{ id: "item-1", name: "Review", resolved: true, parent: null }],
        },
      ],
    };
    const entriesPayload = {
      data: [{ user: { username: "Alice" }, intervals: [{ start: "1700000000000", time: "1800000" }] }],
    };
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch((call) => jsonResponse(call.url.endsWith("/time") ? entriesPayload : taskPayload));

    const io = new BufferedOutput();
    const exitCode = await run(["--task-id", "abc123", "--json"], io);

    expect(exitCode).toBe(0);
    const data = JSON.parse(io.out);
    expect(data.title).toBe("JSON Task");
    expect(data.checklists).toEqual([
      {
        id: "check-1",
        name: "Release",
        items: [{ id: "item-1", name: "Review", resolved: true, parent: null, children: [] }],
      },
    ]);
    expect(data.time_entries[0].user).toBe("Alice");
  });

  it("run_fetches_task_and_prints_details", async () => {
    const taskPayload = {
      name: "Task Title",
      status: { status: "open" },
      description: "Body",
      time_estimate: null,
      time_spent: 0,
      tags: [],
      custom_fields: [],
    };
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch(() => jsonResponse(taskPayload));

    const io = new BufferedOutput();
    const exitCode = await run(["--task-id", "abc123"], io);

    expect(exitCode).toBe(0);
    expect(calls[0]!.url).toBe(TASK_URL);
    // Python asserted timeout == 15; the TS equivalent is an AbortSignal on the request.
    expect(calls[0]!.signal).toBeDefined();
    expect(io.out).toContain("Title: Task Title");
  });

  it("format_epoch_ms", () => {
    expect(formatEpochMs(null)).toBe("Unknown date");
    expect(formatEpochMs("1700000000000")).toBe("2023-11-14 22:13 UTC");
  });

  it("extract_time_entries", () => {
    const entries = extractTimeEntries([
      {
        user: { username: "Alice", email: "alice@example.com" },
        intervals: [
          { start: "1700100000000", time: "3600000" },
          {
            start: "1700000000000",
            time: "1800000",
            tags: [{ name: "review" }, { name: "billable" }],
          },
        ],
      },
      {
        user: { id: "42" },
        intervals: [{ start: 1700050000000, time: 600000 }],
      },
    ]);

    // Sorted chronologically across users by interval start.
    expect(entries).toHaveLength(3);
    expect(entries[0]!.user).toBe("Alice");
    expect(entries[0]!.date).toBe("2023-11-14 22:13 UTC");
    expect(entries[0]!.duration).toBe("30m (1,800,000 ms)");
    expect(entries[0]!.tags).toEqual(["review", "billable"]);
    expect(entries[1]!.user).toBe("User 42");
    expect(entries[1]!.tags).toEqual([]);
    expect(entries[2]!.user).toBe("Alice");
    expect(entries[2]!.duration).toBe("1h (3,600,000 ms)");
  });

  it("render_includes_time_entries", () => {
    let details = extractTaskDetails(
      {
        name: "Task",
        status: { status: "open" },
        description: "Body",
        time_spent: 1_800_000,
        tags: [],
        custom_fields: [],
      },
      { outcomeFieldId: "" },
    );
    details = {
      ...details,
      timeEntries: [
        {
          user: "Alice",
          date: "2023-11-14 22:13 UTC",
          duration: "30m (1,800,000 ms)",
          startMs: null,
          tags: ["review", "billable"],
        },
      ],
    };
    const rendered = renderTaskDetails(details);

    expect(rendered).toContain("Time entries:");
    expect(rendered).toContain("2023-11-14 22:13 UTC  Alice  30m (1,800,000 ms)  [review, billable]");
  });

  it("run_fetches_time_entries", async () => {
    const taskPayload = {
      id: "abc123",
      team_id: "1234567890",
      name: "Task Title",
      status: { status: "open" },
      description: "Body",
      time_estimate: null,
      time_spent: 1_800_000,
      tags: [],
      custom_fields: [],
    };
    const entriesPayload = {
      data: [{ user: { username: "Alice" }, intervals: [{ start: "1700000000000", time: "1800000" }] }],
    };
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch((call) => jsonResponse(call.url.endsWith("/time") ? entriesPayload : taskPayload));

    const io = new BufferedOutput();
    const exitCode = await run(["--task-id", "abc123"], io);

    expect(exitCode).toBe(0);
    expect(calls.some((call) => call.url.endsWith("/task/abc123/time"))).toBe(true);
    expect(io.out).toContain("Alice");
  });

  it("mcp_read_clickup_task_passes_args_to_runner", () => {
    const argv = readTaskArgv({ task_id: "OOLE-523", team_id: "1234567890" });

    expect(argv).toEqual(["--json", "--task-id", "OOLE-523", "--team-id", "1234567890"]);
    expect(formatToolResult(0, "", "")).toBe("Success.\n");
  });

  it("mcp_read_clickup_task_returns_checklist_items", async () => {
    const task = {
      name: "Task",
      checklists: [
        { id: "c1", name: "Launch", items: [{ id: "i1", name: "Review", resolved: true, parent: null }] },
      ],
    };
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch((call: FetchCall) => jsonResponse(call.url.includes("/time") ? { data: [] } : task));

    const io = new BufferedOutput();
    const code = await run(readTaskArgv({ task_id: "abc123" }), io);
    const result = formatToolResult(code, io.out, io.err);

    expect(result.startsWith("Success.\n")).toBe(true);
    const data = JSON.parse(result.slice("Success.\n".length));
    expect(data.checklists[0].items[0].name).toBe("Review");
    expect(data.checklists[0].items[0].resolved).toBe(true);
  });

  it("mcp_read_clickup_task_passes_comment_options_to_runner", () => {
    const argv = readTaskArgv({
      task_id: "OOLE-523",
      team_id: "1234567890",
      include_comments: true,
      comment_limit: 5,
    });

    expect(argv).toEqual([
      "--json",
      "--task-id",
      "OOLE-523",
      "--team-id",
      "1234567890",
      "--include-comments",
      "--comment-limit",
      "5",
    ]);
    expect(formatToolResult(0, "", "")).toBe("Success.\n");
  });

  it("run_fetches_comments_only_when_requested", async () => {
    const taskPayload = {
      id: "abc123",
      name: "Commented Task",
      status: { status: "open" },
      description: "Body",
      tags: [],
      custom_fields: [],
    };
    const commentsPayload = {
      comments: [
        {
          id: "458",
          comment_text: "First comment",
          user: { username: "Alice" },
          date: "1568036964079",
          resolved: false,
        },
        {
          id: "459",
          comment_text: "Second comment",
          user: { username: "Bob" },
          date: "1568037964079",
          resolved: true,
        },
      ],
    };
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch((call) => {
      if (call.url.includes("/comment")) return jsonResponse(commentsPayload);
      if (call.url.endsWith("/time")) return jsonResponse({ data: [] });
      return jsonResponse(taskPayload);
    });

    const io = new BufferedOutput();
    const exitCode = await run(["--task-id", "abc123", "--json", "--include-comments", "--comment-limit", "1"], io);

    expect(exitCode).toBe(0);
    expect(calls.some((call) => call.url.endsWith("/task/abc123/comment"))).toBe(true);
    const data = JSON.parse(io.out);
    expect(data.comments).toHaveLength(1);
    expect(data.comments[0].text).toBe("First comment");
  });

  it("run_skips_comment_request_by_default", async () => {
    const taskPayload = {
      id: "abc123",
      name: "Task",
      status: { status: "open" },
      description: "Body",
      tags: [],
      custom_fields: [],
    };
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch((call) => jsonResponse(call.url.endsWith("/time") ? { data: [] } : taskPayload));

    const io = new BufferedOutput();
    const exitCode = await run(["--task-id", "abc123", "--json"], io);

    expect(exitCode).toBe(0);
    expect(calls.some((call) => call.url.includes("/comment"))).toBe(false);
  });

  it("comment_fetch_failure_keeps_task_read_successful", async () => {
    const taskPayload = {
      id: "abc123",
      name: "Task",
      status: { status: "open" },
      description: "Body",
      tags: [],
      custom_fields: [],
    };
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch((call) => {
      if (call.url.includes("/comment")) networkFailure("offline");
      if (call.url.endsWith("/time")) return jsonResponse({ data: [] });
      return jsonResponse(taskPayload);
    });

    const io = new BufferedOutput();
    const exitCode = await run(["--task-id", "abc123", "--json", "--include-comments"], io);

    expect(exitCode).toBe(0);
    const data = JSON.parse(io.out);
    expect(data.comments).toEqual([]);
    expect(data.comments_note).toBe("Unavailable (network error: offline)");
  });

  it("run_reads_task_id_from_env_when_not_provided", async () => {
    const taskPayload = {
      name: "Env Task",
      status: { status: "open" },
      description: "Body",
      time_estimate: null,
      time_spent: 0,
      tags: [],
      custom_fields: [],
    };
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    vi.stubEnv("CLICKUP_TASK_ID", "abc123");
    const calls = stubFetch(() => jsonResponse(taskPayload));

    const io = new BufferedOutput();
    const exitCode = await run([], io);

    expect(exitCode).toBe(0);
    expect(calls[0]!.url).toBe(TASK_URL);
  });
});
