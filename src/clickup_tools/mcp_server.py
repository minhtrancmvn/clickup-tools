"""MCP server that exposes ClickUp Tools as agent-callable tools."""

from __future__ import annotations

import io
from contextlib import redirect_stderr, redirect_stdout

from mcp.server.fastmcp import FastMCP

from .update_page import run as run_page
from .update_task import run as run_task

mcp = FastMCP("clickup-tools")


@mcp.tool()
def update_clickup_page(
    file_path: str,
    no_open: bool = True,
    allow_local_media: bool = False,
) -> str:
    """Update a ClickUp Doc page from a Markdown file.

    The markdown file must contain a frontmatter entry pointing at the page:

        ---
        clickup-page: https://app.clickup.com/<workspace>/v/dc/<doc>/<page>
        ---

    Requires the CLICKUP_API_TOKEN environment variable (or a .env file in
    the file's directory).

    Args:
        file_path: Absolute or relative path to the Markdown file.
        no_open:   When True (default) the browser is NOT opened after update.
        allow_local_media: When True, update even if local media paths cannot render in ClickUp.
    """
    argv = [file_path]
    if no_open:
        argv.append("--no-open")
    if allow_local_media:
        argv.append("--allow-local-media")

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()

    with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
        exit_code = run_page(argv)

    return format_tool_result(exit_code, stdout_buf.getvalue(), stderr_buf.getvalue())


@mcp.tool()
def update_clickup_task(
    file_path: str,
    task_id: str = "",
    team_id: str = "",
    no_rich_links: bool = False,
) -> str:
    """Update a ClickUp task description from a Markdown file.

    By default, the markdown file must contain a frontmatter entry pointing at
    the task:

        ---
        clickup-task-id: OOLE-523
        ---

    For custom task IDs, set CLICKUP_TEAM_ID in the environment or .env file.
    The optional task_id and team_id args override frontmatter/environment
    values. Local Markdown image and file links are uploaded as task
    attachments, then rewritten to ClickUp attachment URLs.

    Args:
        file_path: Absolute or relative path to the Markdown file.
        task_id: Optional ClickUp task ID, custom task ID, or task URL override.
        team_id: Optional ClickUp team/workspace ID override.
        no_rich_links: When True, do not normalize bare ClickUp/Figma links.
    """
    argv = [file_path]
    if task_id:
        argv.extend(["--task-id", task_id])
    if team_id:
        argv.extend(["--team-id", team_id])
    if no_rich_links:
        argv.append("--no-rich-links")

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()

    with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
        exit_code = run_task(argv)

    return format_tool_result(exit_code, stdout_buf.getvalue(), stderr_buf.getvalue())


def format_tool_result(exit_code: int, stdout: str, stderr: str) -> str:
    """Format captured CLI output for MCP clients."""

    # Strip ANSI colour codes so the output is clean for the agent.
    import re
    ansi_escape = re.compile(r"\x1b\[[0-9;]*m")
    out = ansi_escape.sub("", stdout)
    err_out = ansi_escape.sub("", stderr)
    combined = (out + err_out).strip()

    if exit_code == 0:
        return f"Success.\n{combined}"
    else:
        return f"Error (exit code {exit_code}).\n{combined}"


def run_server() -> None:
    """Entry point for the clickup-mcp-server command."""
    mcp.run()


if __name__ == "__main__":
    run_server()
