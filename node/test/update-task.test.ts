import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BufferedOutput, FileNotFoundError, pyResolve } from "../src/common.js";
import {
  buildMultipartBody,
  buildTaskUrl,
  extractAttachmentUrl,
  findLocalAttachmentReferences,
  isCustomTaskId,
  parseTaskId,
  prepareMarkdownTaskContent,
  resolveDestination,
  rewriteLocalAttachmentReferences,
  run,
  setTaskCustomField,
  taskDestination,
  updateTaskDescription,
} from "../src/update-task.js";
import { FIXTURES, bodyJson, jsonResponse, stubFetch, tempDir } from "./helpers.js";

function writeMarkdown(content: string, name = "task.md"): string {
  const markdown = path.join(tempDir(), name);
  fs.writeFileSync(markdown, content);
  return markdown;
}

describe("ClickUpUpdateTaskTests", () => {
  it("parse_task_id_from_url", () => {
    expect(parseTaskId("https://app.clickup.com/t/1234567890/OOLE-523")).toBe("OOLE-523");
    expect(parseTaskId("abc123")).toBe("abc123");
  });

  it("is_custom_task_id", () => {
    expect(isCustomTaskId("OOLE-523")).toBe(true);
    expect(isCustomTaskId("abc123")).toBe(false);
  });

  it("build_task_url", () => {
    expect(buildTaskUrl("OOLE-523", "1234567890")).toBe("https://app.clickup.com/t/1234567890/OOLE-523");
  });

  it("resolve_destination_from_metadata_and_env_team_id", () => {
    const markdown = writeMarkdown("---\nclickup-task-id: OOLE-523\n---\n# Body\n");
    vi.stubEnv("CLICKUP_TEAM_ID", "1234567890");

    expect(resolveDestination(markdown)).toEqual(taskDestination("OOLE-523", "1234567890", true));
  });

  it("resolve_destination_prefers_cli_over_metadata", () => {
    const markdown = writeMarkdown("---\nclickup-task-id: OOLE-523\nclickup-team-id: 1\n---\n# Body\n");

    expect(resolveDestination(markdown, { taskId: "abc123", teamId: "2" })).toEqual(taskDestination("abc123", "2", false));
  });

  it("find_local_attachment_references", () => {
    const refs = findLocalAttachmentReferences(
      "![flow](flow.gif)\n" + "[same](flow.gif)\n" + "[remote](https://example.com/file.pdf)\n" + "[anchor](#heading)\n",
      FIXTURES,
    );

    expect(refs).toHaveLength(1);
    expect(refs[0]!.target).toBe("flow.gif");
    expect(refs[0]!.path).toBe(path.join(FIXTURES, "flow.gif"));
  });

  it("rewrite_local_attachment_references", () => {
    const flowPath = pyResolve(path.join(FIXTURES, "flow.gif"));
    const content = "![flow](flow.gif)\n[file](<flow.gif>)\n";

    const rewritten = rewriteLocalAttachmentReferences(
      content,
      FIXTURES,
      new Map([[flowPath, "https://attachments.example/flow.gif"]]),
    );

    expect(rewritten).toBe(
      "![flow](<https://attachments.example/flow.gif>)\n" + "[file](<https://attachments.example/flow.gif>)\n",
    );
  });

  it("prepare_markdown_uploads_each_unique_file_once_and_rewrites", async () => {
    const markdown = writeMarkdown("---\nclickup-task-id: abc123\n---\n" + "![flow](flow.gif)\n" + "[download](flow.gif)\n");
    fs.writeFileSync(path.join(path.dirname(markdown), "flow.gif"), "gif");
    const calls = stubFetch((call) =>
      call.method === "GET" ? jsonResponse({ id: "abc123", attachments: [] }) : jsonResponse({ url: "https://attachments.example/flow.gif" }),
    );

    const prepared = await prepareMarkdownTaskContent(markdown, "pk_test", taskDestination("abc123"), { richLinks: false });

    // One Get Task (existing attachments), then a single upload for the file referenced twice.
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.clickup.com/api/v2/task/abc123",
      "POST https://api.clickup.com/api/v2/task/abc123/attachment",
    ]);
    expect(prepared.content).toContain("![flow](<https://attachments.example/flow.gif>)");
    expect(prepared.content).toContain("[download](<https://attachments.example/flow.gif>)");
  });

  it("prepare_markdown_strips_leading_h1_into_title", async () => {
    const markdown = writeMarkdown(
      "---\nclickup-task-id: abc123\n---\n" +
        "# SQLSTATE[HY000]: General error: 2006 MySQL server has gone away\n\n" +
        "## Source\n" +
        "- Slack thread: https://example.com/thread\n",
    );

    const prepared = await prepareMarkdownTaskContent(markdown, "pk_test", taskDestination("abc123"), { richLinks: false });

    expect(prepared.title).toBe("SQLSTATE[HY000]: General error: 2006 MySQL server has gone away");
    expect(prepared.content).toBe("## Source\n- Slack thread: https://example.com/thread\n");
  });

  it("prepare_markdown_aborts_on_missing_attachment", async () => {
    const markdown = writeMarkdown("---\nclickup-task-id: abc123\n---\n![missing](missing.png)\n");

    await expect(
      prepareMarkdownTaskContent(markdown, "pk_test", taskDestination("abc123"), { richLinks: false }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("update_task_description_uses_markdown_content_and_custom_query", async () => {
    const calls = stubFetch(() => jsonResponse({}));

    await updateTaskDescription(taskDestination("OOLE-523", "1234567890", true), "# Body", "pk_test");

    expect(calls[0]!.url).toBe("https://api.clickup.com/api/v2/task/OOLE-523?custom_task_ids=true&team_id=1234567890");
    expect(bodyJson(calls[0]!)).toEqual({ markdown_content: "# Body" });
  });

  it("update_task_description_can_update_name", async () => {
    const calls = stubFetch(() => jsonResponse({}));

    await updateTaskDescription(taskDestination("abc123"), "## Body", "pk_test", "Task Title");

    expect(bodyJson(calls[0]!)).toEqual({ markdown_content: "## Body", name: "Task Title" });
  });

  it("build_multipart_body_uses_attachment_field", () => {
    const asset = path.join(tempDir(), "flow.gif");
    fs.writeFileSync(asset, "gif");

    const body = buildMultipartBody(asset, "boundary").toString("utf8");

    expect(body).toContain('name="attachment"; filename="flow.gif"');
    expect(body).toContain("Content-Type: image/gif");
  });

  it("extract_attachment_url", () => {
    expect(extractAttachmentUrl({ attachment: { url: "https://example.com/file.png" } })).toBe(
      "https://example.com/file.png",
    );
  });

  it("prepare_markdown_reads_outcome_from_frontmatter", async () => {
    const markdown = writeMarkdown(
      "---\nclickup-task-id: abc123\noutcome: Fixed and deployed\n---\n" + "# Task Title\n\n" + "## Source\n- link\n",
    );

    const prepared = await prepareMarkdownTaskContent(markdown, "pk_test", taskDestination("abc123"), { richLinks: false });

    expect(prepared.outcome).toBe("Fixed and deployed");
  });

  it("prepare_markdown_outcome_absent_from_frontmatter", async () => {
    const markdown = writeMarkdown(
      "---\nclickup-task-id: abc123\n---\n" + "# Task Title\n\n" + "## Outcome\n- this heading is ignored now\n",
    );

    const prepared = await prepareMarkdownTaskContent(markdown, "pk_test", taskDestination("abc123"), { richLinks: false });

    expect(prepared.outcome).toBeNull();
  });

  it("set_task_custom_field", async () => {
    const calls = stubFetch(() => jsonResponse({}));

    await setTaskCustomField(taskDestination("abc123"), "8477a7ee-f750-4e8e-8298-0131ef93adab", "Fixed", "pk_test");

    expect(calls[0]!.url).toBe("https://api.clickup.com/api/v2/task/abc123/field/8477a7ee-f750-4e8e-8298-0131ef93adab");
    expect(bodyJson(calls[0]!)).toEqual({ value: "Fixed" });
  });

  it("prepare_markdown_extracts_outcome", async () => {
    const markdown = writeMarkdown(
      "---\nclickup-task-id: abc123\noutcome: Fixed the bug and deployed\n---\n" +
        "# Task Title\n\n" +
        "## Source\n- link\n\n" +
        "## Notes\nmore text\n",
    );

    const prepared = await prepareMarkdownTaskContent(markdown, "pk_test", taskDestination("abc123"), { richLinks: false });

    expect(prepared.title).toBe("Task Title");
    expect(prepared.outcome).toBe("Fixed the bug and deployed");
    expect(prepared.content).toBe("## Source\n- link\n\n## Notes\nmore text\n");
  });
});

describe("TypeScript port behaviour", () => {
  it("custom_task_id_attachments_resolve_internal_id_before_upload", async () => {
    const markdown = writeMarkdown("---\nclickup-task-id: OOLE-1\n---\n![flow](flow.gif)\n");
    fs.writeFileSync(path.join(path.dirname(markdown), "flow.gif"), "gif");
    const calls = stubFetch((call) =>
      call.url.endsWith("/attachment") ? jsonResponse({ url: "https://cdn/flow.gif" }) : jsonResponse({ id: "86internal" }),
    );

    const prepared = await prepareMarkdownTaskContent(markdown, "pk_test", taskDestination("OOLE-1", "999", true), {
      richLinks: false,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.clickup.com/api/v2/task/OOLE-1?custom_task_ids=true&team_id=999",
      "https://api.clickup.com/api/v2/task/86internal/attachment",
    ]);
    expect(prepared.content).toBe("![flow](<https://cdn/flow.gif>)\n");
  });

  it("run_updates_description_then_outcome_field", async () => {
    const markdown = writeMarkdown("---\nclickup-task-id: abc123\noutcome: Shipped\n---\n# Title\n\nBody\n");
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    vi.stubEnv("CLICKUP_OUTCOME_FIELD_ID", "field-9");
    const calls = stubFetch(() => jsonResponse({}));
    const io = new BufferedOutput();

    const code = await run([markdown, "--no-rich-links"], io);

    expect(code).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "PUT https://api.clickup.com/api/v2/task/abc123",
      "POST https://api.clickup.com/api/v2/task/abc123/field/field-9",
    ]);
    expect(bodyJson(calls[0]!)).toEqual({ markdown_content: "Body\n", name: "Title" });
    expect(io.out).toContain("Outcome field updated (field-9)");
    expect(io.out).toContain("Task description updated");
  });

  it("run_requires_team_id_for_custom_task_id", async () => {
    const markdown = writeMarkdown("---\nclickup-task-id: OOLE-1\n---\nBody\n");
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const io = new BufferedOutput();

    expect(await run([markdown], io)).toBe(1);
    expect(io.err).toContain("CLICKUP_TEAM_ID is required when using a custom task ID.");
  });

  it("run_rejects_extra_positionals_like_argparse", async () => {
    const io = new BufferedOutput();
    expect(await run(["a", "b"], io)).toBe(2);
    expect(io.err).toContain("clickup-update-task: error: unrecognized arguments: b");
  });
});
