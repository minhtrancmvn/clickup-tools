import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { BufferedOutput, type Output } from "../src/common.js";
import {
  createServer,
  formatToolResult,
  main,
  packageVersion,
  readTaskArgv,
  updatePageArgv,
  updateTaskArgv,
  type ToolRunners,
} from "../src/mcp-server.js";
import { FIXTURES, jsonResponse, stubFetch } from "./helpers.js";

async function connect(runners?: Partial<ToolRunners>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(runners).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content[0]!.text;
}

describe("argv builders (mirror mcp_server.py)", () => {
  it("update_page_defaults_to_no_open", () => {
    expect(updatePageArgv({ file_path: "/a.md" })).toEqual(["/a.md", "--no-open"]);
    expect(updatePageArgv({ file_path: "/a.md", no_open: false, allow_local_media: true })).toEqual([
      "/a.md",
      "--allow-local-media",
    ]);
  });

  it("update_task_passes_overrides", () => {
    expect(updateTaskArgv({ file_path: "/a.md", task_id: "OOLE-1", team_id: "9", no_rich_links: true })).toEqual([
      "/a.md",
      "--task-id",
      "OOLE-1",
      "--team-id",
      "9",
      "--no-rich-links",
    ]);
  });

  it("read_task_only_sends_comment_limit_with_comments", () => {
    expect(readTaskArgv({ task_id: "OOLE-1", comment_limit: 5 })).toEqual(["--json", "--task-id", "OOLE-1"]);
    expect(readTaskArgv({ include_comments: true, comment_limit: 5 })).toEqual([
      "--json",
      "--include-comments",
      "--comment-limit",
      "5",
    ]);
  });

  it("format_tool_result_strips_ansi_and_labels_exit_code", () => {
    expect(formatToolResult(0, "\x1b[92m[ok]\x1b[0m done\n", "")).toBe("Success.\n[ok] done");
    expect(formatToolResult(1, "out\n", "\x1b[91m[error]\x1b[0m bad\n")).toBe("Error (exit code 1).\nout\n[error] bad");
  });
});

describe("MCP protocol", () => {
  it("lists_all_tools_with_their_schemas", async () => {
    const client = await connect();

    expect(client.getServerVersion()).toMatchObject({ name: "clickup-tools", version: packageVersion() });
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(Object.keys(byName).sort()).toEqual([
      "add_clickup_comment",
      "edit_clickup_comment",
      "pull_clickup_page",
      "pull_clickup_task",
      "read_clickup_task",
      "update_clickup_page",
      "update_clickup_task",
    ]);
    expect(byName.edit_clickup_comment!.inputSchema.required).toEqual(["comment_id"]);
    expect(byName.pull_clickup_page!.inputSchema.required).toEqual(["page_url"]);
    expect(byName.pull_clickup_task!.inputSchema.required ?? []).toEqual([]);
    expect(byName.update_clickup_page!.inputSchema.required).toEqual(["file_path"]);
    expect(byName.update_clickup_task!.inputSchema.required).toEqual(["file_path"]);
    expect(byName.read_clickup_task!.inputSchema.required ?? []).toEqual([]);
    expect(byName.read_clickup_task!.inputSchema.properties).toMatchObject({
      comment_limit: { type: "integer", default: 20 },
      include_comments: { type: "boolean", default: false },
    });
    await client.close();
  });

  it("tool_call_applies_defaults_and_captures_output", async () => {
    const seen: string[][] = [];
    const fake = async (argv: readonly string[], io: Output): Promise<number> => {
      seen.push([...argv]);
      io.stdout("\x1b[92m[ok]\x1b[0m hello\n");
      io.stderr("warn\n");
      return 0;
    };
    const client = await connect({ updatePage: fake, updateTask: fake, readTask: fake });

    const result = await client.callTool({ name: "update_clickup_page", arguments: { file_path: "/tmp/x.md" } });

    expect(seen).toEqual([["/tmp/x.md", "--no-open"]]);
    expect(textOf(result)).toBe("Success.\n[ok] hello\nwarn");
    await client.close();
  });

  it("read_clickup_task_end_to_end_returns_json_without_touching_stdout", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch((call) =>
      call.url.endsWith("/time")
        ? jsonResponse({ data: [] })
        : jsonResponse({ id: "abc123", name: "Task", status: { status: "open" }, custom_fields: [] }),
    );
    const client = await connect();
    const stdoutWrite = vi.spyOn(process.stdout, "write");

    const result = await client.callTool({ name: "read_clickup_task", arguments: { task_id: "abc123" } });

    expect(stdoutWrite).not.toHaveBeenCalled();
    const text = textOf(result);
    expect(text.startsWith("Success.\n")).toBe(true);
    const data = JSON.parse(text.slice("Success.\n".length));
    expect(data).toMatchObject({ title: "Task", status: "open", url: "https://app.clickup.com/t/abc123" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.clickup.com/api/v2/task/abc123?include_subtasks=true&include_markdown_description=true",
      "https://api.clickup.com/api/v2/task/abc123/time",
      "https://api.clickup.com/api/v2/task/abc123/time_in_status",
    ]);
    await client.close();
  });

  it("edit_clickup_comment_end_to_end_sends_put", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch(() => jsonResponse({}));
    const client = await connect();

    const result = await client.callTool({ name: "edit_clickup_comment", arguments: { comment_id: "458", text: "Fixed in **v2**" } });

    expect(textOf(result)).toMatch(/^Success\.\n[\s\S]*Comment 458 updated/);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(["PUT https://api.clickup.com/api/v2/comment/458"]);
    await client.close();
  });

  it("errors_are_reported_in_text_not_thrown", async () => {
    const client = await connect();

    const result = await client.callTool({
      name: "update_clickup_page",
      arguments: { file_path: path.join(FIXTURES, "missing.md") },
    });

    expect(textOf(result)).toMatch(/^Error \(exit code 1\)\.\n\[error\] File not found: /);
    await client.close();
  });
});

describe("server CLI", () => {
  it("version_and_help_exit_cleanly", async () => {
    const io = new BufferedOutput();
    await main(["--version"], io);
    expect(io.out).toBe(`${packageVersion()}\n`);

    const help = new BufferedOutput();
    await main(["--help"], help);
    expect(help.out).toContain("--env-file PATH");
  });

  it("unknown_option_is_a_usage_error", async () => {
    const io = new BufferedOutput();
    try {
      await main(["--bogus"], io);
      expect(process.exitCode).toBe(2);
      expect(io.err).toContain("clickup-mcp-server: error: unrecognized arguments: --bogus");
    } finally {
      process.exitCode = 0;
    }
  });
});
