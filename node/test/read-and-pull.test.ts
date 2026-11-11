import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { BufferedOutput } from "../src/common.js";
import { createServer, pullPageArgv, pullTaskArgv } from "../src/mcp-server.js";
import {
  buildMarkdownFile,
  formatEstimate,
  frontMatterValue,
  runPullPage,
  runPullTask,
} from "../src/pull.js";
import {
  extractAttachments,
  extractDependencies,
  extractLinkedTasks,
  extractTimeInStatus,
  formatMinutes,
  run as runReadTask,
} from "../src/read-task.js";
import { parseFrontMatter } from "../src/update-page.js";
import { run as runUpdatePage } from "../src/update-page.js";
import { run as runUpdateTask } from "../src/update-task.js";
import { bodyJson, jsonResponse, stubFetch, tempDir } from "./helpers.js";

const PAGE_URL = "https://app.clickup.com/123/v/dc/doc-1/page-2";

const RICH_TASK = {
  id: "abc123",
  name: "Rich task",
  status: { status: "in progress" },
  assignees: [{ username: "Ann" }, { email: "bo@example.com" }],
  priority: { priority: "high", color: "#ffcc00" },
  start_date: "1763600000000",
  due_date: "1764000000000",
  points: 3,
  parent: "parent9",
  list: { id: "900", name: "Sprint 5", access: true },
  dependencies: [
    { task_id: "abc123", depends_on: "dep1", type: 1 },
    { task_id: "blocked2", depends_on: "abc123", type: 1 },
  ],
  linked_tasks: [
    { task_id: "abc123", link_id: "link1" },
    { task_id: "link2", link_id: "abc123" },
  ],
  attachments: [
    { title: "spec.pdf", url: "https://cdn/spec.pdf", size: 1200 },
    { title: "old.png", url: "https://cdn/old.png", size: "10", deleted: true },
  ],
  custom_fields: [],
};

describe("read-task: richer output", () => {
  it("extracts_dependencies_links_and_live_attachments", () => {
    expect(extractDependencies(RICH_TASK)).toEqual({ waitingOn: ["dep1"], blocking: ["blocked2"] });
    expect(extractLinkedTasks(RICH_TASK)).toEqual(["link1", "link2"]);
    expect(extractAttachments(RICH_TASK)).toEqual([{ title: "spec.pdf", url: "https://cdn/spec.pdf", size: 1200 }]);
  });

  it("parses_time_in_status_and_treats_empty_as_unavailable", () => {
    expect(extractTimeInStatus({ current_status: {}, status_history: [] })).toBeNull();
    expect(
      extractTimeInStatus({
        current_status: { status: "review", total_time: { by_minute: 95, since: "1763600000000" } },
        status_history: [
          { status: "open", total_time: { by_minute: 1500 } },
          { status: "review", total_time: { by_minute: 95 } },
        ],
      }),
    ).toEqual({
      current: { status: "review", minutes: 95, sinceMs: 1763600000000 },
      history: [
        { status: "open", minutes: 1500 },
        { status: "review", minutes: 95 },
      ],
    });
    expect([formatMinutes(0), formatMinutes(45), formatMinutes(95), formatMinutes(1500)]).toEqual(["0m", "45m", "1h 35m", "1d 1h"]);
  });

  it("includes_the_new_fields_in_json_and_text", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch((call) => {
      if (call.url.endsWith("/time")) return jsonResponse({ data: [] });
      if (call.url.endsWith("/time_in_status")) {
        return jsonResponse({
          current_status: { status: "in progress", total_time: { by_minute: 30, since: "1763600000000" } },
          status_history: [{ status: "open", total_time: { by_minute: 60 } }],
        });
      }
      return jsonResponse(RICH_TASK);
    });

    const json = new BufferedOutput();
    expect(await runReadTask(["abc123", "--json"], json)).toBe(0);
    const data = JSON.parse(json.out);
    expect(data).toMatchObject({
      assignees: ["Ann", "bo@example.com"],
      priority: "high",
      start_date: "2025-11-20 00:53 UTC",
      start_date_ms: 1763600000000,
      due_date_ms: 1764000000000,
      points: 3,
      parent: "parent9",
      list: { id: "900", name: "Sprint 5" },
      dependencies: { waiting_on: ["dep1"], blocking: ["blocked2"] },
      linked_tasks: ["link1", "link2"],
      attachments: [{ title: "spec.pdf", url: "https://cdn/spec.pdf", size: 1200 }],
      time_in_status: { current: { status: "in progress", minutes: 30 }, history: [{ status: "open", minutes: 60 }] },
    });

    const text = new BufferedOutput();
    await runReadTask(["abc123"], text);
    for (const line of [
      "Assignees: Ann, bo@example.com",
      "Priority: high",
      "Points: 3",
      "List: Sprint 5 (900)",
      "Parent task: parent9",
      "Waiting on: dep1",
      "Blocking: blocked2",
      "Linked tasks: link1, link2",
      "Attachments: 1\n  - spec.pdf  https://cdn/spec.pdf",
      "Time in status:\n  - in progress  30m  (current)\n  - open  1h",
    ]) {
      expect(text.out).toContain(line);
    }
  });

  it("reports_unset_fields_and_time_in_status_failures", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch((call) => {
      if (call.url.endsWith("/time")) return jsonResponse({ data: [] });
      if (call.url.endsWith("/time_in_status")) return new Response("{}", { status: 401 });
      return jsonResponse({ id: "abc123", name: "Bare", priority: null, start_date: null, points: null });
    });

    const json = new BufferedOutput();
    await runReadTask(["abc123", "--json"], json);
    expect(JSON.parse(json.out)).toMatchObject({
      assignees: [],
      priority: null,
      start_date: null,
      points: null,
      parent: null,
      list: null,
      attachments: [],
      time_in_status: null,
      time_in_status_note: "Unavailable (API error 401)",
    });

    const text = new BufferedOutput();
    await runReadTask(["abc123"], text);
    expect(text.out).toContain("Priority: Not set\nStart date: Not set\nDue date: Not set\nPoints: Not set");
    expect(text.out).toContain("Time in status: Unavailable (API error 401)");
  });
});

describe("pull: Markdown building", () => {
  it("quotes_only_values_the_parser_would_change", () => {
    expect(frontMatterValue("in progress")).toBe("in progress");
    expect(frontMatterValue("a: b")).toBe("a: b");
    expect(frontMatterValue(" padded ")).toBe("' padded '");
    expect(frontMatterValue('"quoted"')).toBe(`'"quoted"'`);
    expect(frontMatterValue("it's 'x'")).toBe("it's 'x'");
    expect(frontMatterValue("'quoted' it's")).toBe(`"'quoted' it's"`);
    // Every value survives the round trip through the front matter parser unchanged.
    for (const value of ["in progress", " padded ", '"quoted"', "a: b", "it's 'x'", "'quoted' it's", "'both'"]) {
      const [metadata] = parseFrontMatter(`---\nk: ${frontMatterValue(value)}\n---\n`);
      expect(metadata.k).toBe(value);
    }
  });

  it("builds_front_matter_title_and_body", () => {
    expect(buildMarkdownFile([["clickup-page", PAGE_URL]], "Title", "\n\nBody text")).toBe(
      `---\nclickup-page: ${PAGE_URL}\n---\n\n# Title\n\nBody text\n`,
    );
    expect(buildMarkdownFile([], "Empty", "")).toBe("---\n---\n\n# Empty\n\n");
    expect([formatEstimate(5_400_000), formatEstimate(7_200_000), formatEstimate(2_700_000), formatEstimate(20_000)]).toEqual([
      "1h 30m",
      "2h",
      "45m",
      "",
    ]);
  });
});

describe("pull: pages", () => {
  function stubPage(page: Record<string, unknown>) {
    return stubFetch(() => jsonResponse(page));
  }

  it("prints_markdown_with_front_matter_and_requests_text_md", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubPage({ id: "page-2", name: "Spec", sub_title: "Draft", content: "## Intro\n\nHello\n" });
    const io = new BufferedOutput();

    expect(await runPullPage([`${PAGE_URL}?x=1`], io)).toBe(0);

    expect(calls[0]!.url).toBe("https://api.clickup.com/api/v3/workspaces/123/docs/doc-1/pages/page-2?content_format=text%2Fmd");
    expect(io.out).toBe(`---\nclickup-page: ${PAGE_URL}\nsubtitle: Draft\n---\n\n# Spec\n\n## Intro\n\nHello\n`);
  });

  it("writes_a_file_refuses_to_overwrite_and_honours_force", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubPage({ name: "Spec", content: "v1" });
    const file = path.join(tempDir(), "nested", "spec.md");

    const first = new BufferedOutput();
    expect(await runPullPage([PAGE_URL, "-o", file], first)).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toContain("# Spec\n\nv1\n");
    expect(first.out).toContain("Pulled : Spec");

    stubPage({ name: "Spec", content: "v2" });
    const again = new BufferedOutput();
    expect(await runPullPage([PAGE_URL, "--output", file], again)).toBe(1);
    expect(again.err).toContain("already exists. Pass --force to overwrite it.");
    expect(fs.readFileSync(file, "utf8")).toContain("v1");

    expect(await runPullPage([PAGE_URL, "-o", file, "--force"], new BufferedOutput())).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toContain("v2");
  });

  it("round_trips_through_update_page", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubPage({ name: "Spec", sub_title: "Draft", content: "## Intro\n\n- one\n- two\n" });
    const file = path.join(tempDir(), "spec.md");
    await runPullPage([PAGE_URL, "-o", file], new BufferedOutput());

    const calls = stubFetch(() => new Response(""));
    expect(await runUpdatePage([file, "--no-open", "--no-rich-links"], new BufferedOutput())).toBe(0);

    expect(calls[0]!.url).toBe("https://api.clickup.com/api/v3/workspaces/123/docs/doc-1/pages/page-2");
    expect(bodyJson(calls[0]!)).toEqual({
      content: "## Intro\n\n- one\n- two\n",
      content_format: "text/md",
      content_edit_mode: "replace",
      name: "Spec",
      sub_title: "Draft",
    });
  });
});

describe("pull: tasks", () => {
  const TASK = {
    id: "86x1",
    custom_id: "OOLE-7",
    team_id: "9018",
    name: "Fix login",
    status: { status: "review" },
    priority: { priority: "urgent" },
    points: 2,
    time_estimate: 5_400_000,
    due_date: "1764000000000",
    markdown_description: "## Steps\n\n1. Open\n2. Login\n",
    description: "Steps Open Login",
    custom_fields: [{ id: "f1", name: "Outcome", type: "text", value: "Fixed: token refresh" }],
  };

  it("writes_routing_and_field_front_matter_and_notes_skipped_dates", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    vi.stubEnv("CLICKUP_TEAM_ID", "9018");
    const calls = stubFetch(() => jsonResponse(TASK));
    const io = new BufferedOutput();

    expect(await runPullTask(["OOLE-7"], io)).toBe(0);

    expect(calls[0]!.url).toBe(
      "https://api.clickup.com/api/v2/task/OOLE-7?include_markdown_description=true&custom_task_ids=true&team_id=9018",
    );
    expect(io.out).toBe(
      "---\nclickup-task-id: OOLE-7\nclickup-team-id: 9018\noutcome: Fixed: token refresh\nstatus: review\npriority: urgent\npoints: 2\ntime_estimate: 1h 30m\n---\n\n# Fix login\n\n## Steps\n\n1. Open\n2. Login\n",
    );
    expect(io.err).toContain("Start and due dates are not written");
  });

  it("leaves_out_multi_line_outcomes_and_uses_internal_ids", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch(() =>
      jsonResponse({ id: "86x2", name: "Plain", markdown_description: "", description: "text", custom_fields: [{ name: "Outcome", value: "a\nb" }] }),
    );
    const io = new BufferedOutput();

    await runPullTask(["86x2"], io);

    expect(io.out).toBe("---\nclickup-task-id: 86x2\n---\n\n# Plain\n\ntext\n");
    expect(io.err).toContain("Outcome has several lines");
  });

  it("round_trips_through_update_task", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    vi.stubEnv("CLICKUP_OUTCOME_FIELD_ID", "f1");
    stubFetch(() => jsonResponse(TASK));
    const file = path.join(tempDir(), "OOLE-7.md");
    expect(await runPullTask(["OOLE-7", "--team-id", "9018", "-o", file], new BufferedOutput())).toBe(0);

    const calls = stubFetch(() => jsonResponse({}));
    expect(await runUpdateTask([file, "--no-rich-links"], new BufferedOutput())).toBe(0);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "PUT https://api.clickup.com/api/v2/task/OOLE-7?custom_task_ids=true&team_id=9018",
      "POST https://api.clickup.com/api/v2/task/OOLE-7/field/f1?custom_task_ids=true&team_id=9018",
    ]);
    expect(bodyJson(calls[0]!)).toEqual({
      markdown_content: "## Steps\n\n1. Open\n2. Login\n",
      name: "Fix login",
      status: "review",
      priority: 1,
      points: 2,
      time_estimate: 5_400_000,
    });
    expect(bodyJson(calls[1]!)).toEqual({ value: "Fixed: token refresh" });
  });
});

describe("pull: MCP tools", () => {
  it("builds_argv", () => {
    expect(pullPageArgv({ page_url: PAGE_URL })).toEqual([PAGE_URL]);
    expect(pullPageArgv({ page_url: PAGE_URL, file_path: "/tmp/a.md", overwrite: true })).toEqual([PAGE_URL, "--output", "/tmp/a.md", "--force"]);
    expect(pullTaskArgv({})).toEqual([]);
    expect(pullTaskArgv({ task_id: "OOLE-7", team_id: "9", file_path: "t.md" })).toEqual(["OOLE-7", "--team-id", "9", "--output", "t.md"]);
  });

  it("returns_markdown_when_no_file_path", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch(() => jsonResponse({ name: "Spec", content: "Body" }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "pull_clickup_page", arguments: { page_url: PAGE_URL } });

    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toBe(`Success.\n---\nclickup-page: ${PAGE_URL}\n---\n\n# Spec\n\nBody`);
    await client.close();
  });
});
