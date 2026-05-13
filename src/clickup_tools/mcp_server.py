"""MCP server that exposes ClickUp Tools as agent-callable tools."""

from __future__ import annotations

import io
import sys
from contextlib import redirect_stderr, redirect_stdout

from mcp.server.fastmcp import FastMCP

from .update_page import run

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
        exit_code = run(argv)

    # Strip ANSI colour codes so the output is clean for the agent.
    import re
    ansi_escape = re.compile(r"\x1b\[[0-9;]*m")
    out = ansi_escape.sub("", stdout_buf.getvalue())
    err_out = ansi_escape.sub("", stderr_buf.getvalue())
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
