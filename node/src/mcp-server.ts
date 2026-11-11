/** MCP server that exposes ClickUp Tools as agent-callable tools over stdio. */

import fs from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BufferedOutput, expandUser, parseCli, processOutput, stringOption, type CliSpec, type Output } from "./common.js";
import { ENV_FILE_ENV_VAR } from "./env.js";
import { run as runReadTask } from "./read-task.js";
import { run as runPage } from "./update-page.js";
import { run as runTask } from "./update-task.js";

type Runner = (argv: readonly string[], io: Output) => Promise<number>;

export interface ToolRunners {
  updatePage: Runner;
  updateTask: Runner;
  readTask: Runner;
}

const defaultRunners: ToolRunners = { updatePage: runPage, updateTask: runTask, readTask: runReadTask };

export function packageVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "0.0.0";
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

/** Format captured CLI output for MCP clients. */
export function formatToolResult(exitCode: number, stdout: string, stderr: string): string {
  const combined = (stdout.replace(ANSI_ESCAPE_RE, "") + stderr.replace(ANSI_ESCAPE_RE, "")).trim();
  return exitCode === 0 ? `Success.\n${combined}` : `Error (exit code ${exitCode}).\n${combined}`;
}

export function updatePageArgv({
  file_path,
  no_open = true,
  allow_local_media = false,
}: {
  file_path: string;
  no_open?: boolean;
  allow_local_media?: boolean;
}): string[] {
  const argv = [file_path];
  if (no_open) argv.push("--no-open");
  if (allow_local_media) argv.push("--allow-local-media");
  return argv;
}

export function updateTaskArgv({
  file_path,
  task_id = "",
  team_id = "",
  no_rich_links = false,
}: {
  file_path: string;
  task_id?: string;
  team_id?: string;
  no_rich_links?: boolean;
}): string[] {
  const argv = [file_path];
  if (task_id) argv.push("--task-id", task_id);
  if (team_id) argv.push("--team-id", team_id);
  if (no_rich_links) argv.push("--no-rich-links");
  return argv;
}

export function readTaskArgv({
  task_id = "",
  team_id = "",
  include_comments = false,
  comment_limit = 20,
}: {
  task_id?: string;
  team_id?: string;
  include_comments?: boolean;
  comment_limit?: number;
}): string[] {
  const argv = ["--json"];
  if (task_id) argv.push("--task-id", task_id);
  if (team_id) argv.push("--team-id", team_id);
  if (include_comments) argv.push("--include-comments", "--comment-limit", String(comment_limit));
  return argv;
}

async function callRunner(runner: Runner, argv: string[]) {
  const io = new BufferedOutput();
  const exitCode = await runner(argv, io);
  return { content: [{ type: "text" as const, text: formatToolResult(exitCode, io.out, io.err) }] };
}

const UPDATE_PAGE_DESCRIPTION = `Update a ClickUp Doc page from a Markdown file.

The markdown file must contain a frontmatter entry pointing at the page:

    ---
    clickup-page: https://app.clickup.com/<workspace>/v/dc/<doc>/<page>
    ---

Requires the CLICKUP_API_TOKEN environment variable (or a .env file passed with --env-file).`;

const UPDATE_TASK_DESCRIPTION = `Update a ClickUp task description from a Markdown file.

By default, the markdown file must contain a frontmatter entry pointing at the task:

    ---
    clickup-task-id: OOLE-523
    ---

For custom task IDs, set CLICKUP_TEAM_ID in the environment or .env file. The optional task_id and team_id args override frontmatter/environment values. Local Markdown image and file links are uploaded as task attachments, then rewritten to ClickUp attachment URLs.`;

const READ_TASK_DESCRIPTION = `Read selected details from a ClickUp task as a JSON document.

Returns a JSON object with title, status, description, time estimate, tracked time, tags, the Outcome custom field, individual time entries (user, date, duration), checklists with item completion, nested subtasks, and the task URL. Call with include_comments=true when recent discussion is needed; comments are omitted by default to keep reads fast and output small.

When task_id is omitted, it is read from CLICKUP_TASK_ID in the environment or .env file. For custom task IDs, set CLICKUP_TEAM_ID in the environment or .env file. The optional team_id arg overrides the environment value.`;

/** Build the MCP server with all ClickUp tools registered. */
export function createServer(runners: ToolRunners = defaultRunners): McpServer {
  const server = new McpServer({ name: "clickup-tools", version: packageVersion() });

  server.registerTool(
    "update_clickup_page",
    {
      description: UPDATE_PAGE_DESCRIPTION,
      inputSchema: {
        file_path: z.string().describe("Absolute or relative path to the Markdown file."),
        no_open: z.boolean().default(true).describe("When true (default) the browser is NOT opened after update."),
        allow_local_media: z
          .boolean()
          .default(false)
          .describe("When true, update even if local media paths cannot render in ClickUp."),
      },
    },
    async (args) => callRunner(runners.updatePage, updatePageArgv(args)),
  );

  server.registerTool(
    "update_clickup_task",
    {
      description: UPDATE_TASK_DESCRIPTION,
      inputSchema: {
        file_path: z.string().describe("Absolute or relative path to the Markdown file."),
        task_id: z.string().default("").describe("Optional ClickUp task ID, custom task ID, or task URL override."),
        team_id: z.string().default("").describe("Optional ClickUp team/workspace ID override."),
        no_rich_links: z.boolean().default(false).describe("When true, do not normalize bare ClickUp/Figma links."),
      },
    },
    async (args) => callRunner(runners.updateTask, updateTaskArgv(args)),
  );

  server.registerTool(
    "read_clickup_task",
    {
      description: READ_TASK_DESCRIPTION,
      inputSchema: {
        task_id: z
          .string()
          .default("")
          .describe("Optional ClickUp task ID, custom task ID, or task URL. Falls back to CLICKUP_TASK_ID when omitted."),
        team_id: z.string().default("").describe("Optional ClickUp team/workspace ID for custom task IDs."),
        include_comments: z.boolean().default(false).describe("Include recent task comments when true. Defaults to false."),
        comment_limit: z.number().int().default(20).describe("Maximum comments to return, from 1 to 25. Defaults to 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => callRunner(runners.readTask, readTaskArgv(args)),
  );

  return server;
}

export const PROG = "clickup-mcp-server";

const USAGE = "usage: clickup-mcp-server [-h] [--version] [--env-file PATH]\n";

export const CLI: CliSpec = {
  prog: PROG,
  usage: USAGE,
  help: `${USAGE}
Run the ClickUp Tools MCP server over stdio.

options:
  -h, --help       show this help message and exit
  --version        show the package version and exit
  --env-file PATH  Dotenv file containing CLICKUP_API_TOKEN and
                   CLICKUP_TEAM_ID.
`,
  maxPositionals: 0,
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean" },
    "env-file": { type: "string" },
  },
};

/** Entry point for the clickup-mcp-server / clickup-tools-mcp commands. */
export async function main(argv: readonly string[] = process.argv.slice(2), io: Output = processOutput): Promise<void> {
  const parsed = parseCli(CLI, argv, io);
  if (typeof parsed === "number") {
    process.exitCode = parsed;
    return;
  }
  if (parsed.values.version === true) {
    io.stdout(`${packageVersion()}\n`);
    return;
  }

  const envFile = stringOption(parsed, "env-file");
  if (envFile) {
    process.env[ENV_FILE_ENV_VAR] = path.resolve(expandUser(envFile));
  }

  await createServer().connect(new StdioServerTransport());
}
