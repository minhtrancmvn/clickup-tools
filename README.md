# ClickUp Tools

Small command-line utilities for ClickUp workflows.

## Install

Create a local virtual environment and install the package in editable mode:

```sh
cd "/Users/coffeemug/Library/Mobile Documents/com~apple~CloudDocs/Programming/ClickUp Tools"
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
python3 -m pip install -e .
```

Add your ClickUp credentials to `.env`:

```sh
CLICKUP_API_TOKEN=pk_your_personal_api_token
CLICKUP_TEAM_ID=your_team_id
```

After installation, these CLI commands are available from the virtual
environment:

```sh
clickup-update-page --help
clickup-update-task --help
clickup-mcp-server --help
```

You can also run the local wrapper scripts directly from this repo:

```sh
./clickup-update-page.py --help
./clickup-update-task.py --help
```

## MCP Setup

The MCP server exposes both tools:

- `update_clickup_page`
- `update_clickup_task`

### VS Code / GitHub Copilot

For VS Code with GitHub Copilot, add this to `.vscode/mcp.json` in the workspace
where you want Copilot to use the tools:

```json
{
  "servers": {
    "clickup-tools": {
      "type": "stdio",
      "command": "/Users/coffeemug/Library/Mobile Documents/com~apple~CloudDocs/Programming/ClickUp Tools/.venv/bin/clickup-mcp-server",
      "envFile": "/Users/coffeemug/Library/Mobile Documents/com~apple~CloudDocs/Programming/ClickUp Tools/.env"
    }
  }
}
```

If this repo is the same workspace where `.vscode/mcp.json` lives, you can use
workspace-relative paths instead:

```json
{
  "servers": {
    "clickup-tools": {
      "type": "stdio",
      "command": "${workspaceFolder}/.venv/bin/clickup-mcp-server",
      "envFile": "${workspaceFolder}/.env"
    }
  }
}
```

In VS Code, start the server from the MCP controls or run `MCP: List Servers`
from the command palette and select `clickup-tools`. In Copilot Chat, switch to
Agent mode and enable the `clickup-tools` tools when needed.

### Codex CLI

Codex manages MCP servers with `codex mcp`. Codex does not use VS Code's
`envFile` field, so point the ClickUp MCP server at this repo's `.env` file
with `--env-file`:

```sh
codex mcp add clickup-tools -- \
  "/Users/coffeemug/Library/Mobile Documents/com~apple~CloudDocs/Programming/ClickUp Tools/.venv/bin/clickup-mcp-server" \
  --env-file "/Users/coffeemug/Library/Mobile Documents/com~apple~CloudDocs/Programming/ClickUp Tools/.env"
codex mcp list
codex mcp get clickup-tools
```

If you need to replace an existing server config:

```sh
codex mcp remove clickup-tools
codex mcp add clickup-tools -- \
  "/Users/coffeemug/Library/Mobile Documents/com~apple~CloudDocs/Programming/ClickUp Tools/.venv/bin/clickup-mcp-server" \
  --env-file "/Users/coffeemug/Library/Mobile Documents/com~apple~CloudDocs/Programming/ClickUp Tools/.env"
```

When asking Codex to use these tools, pass absolute Markdown file paths to
`update_clickup_page` or `update_clickup_task`. For example:

```text
Use update_clickup_task with file_path="/absolute/path/to/spec.md".
```

## Tools

### `clickup-update-page`

Updates a ClickUp Doc page from a Markdown file using the ClickUp Docs API.

```sh
./clickup-update-page.py notes.md
./clickup-update-page.py 'https://app.clickup.com/123/v/dc/doc-id/page-id' notes.md
./clickup-update-page.py --workspace-id 123 --doc-id doc-id --page-id page-id notes.md
./clickup-update-page.py 'https://app.clickup.com/123/v/dc/doc-id/page-id' notes.md --append
./clickup-update-page.py 'https://app.clickup.com/123/v/dc/doc-id/page-id' notes.md --no-open
./clickup-update-page.py notes.md --no-rich-links
./clickup-update-page.py notes.md --allow-local-media
```

Supported page URL formats:

```text
https://app.clickup.com/{workspace_id}/v/dc/{doc_id}/{page_id}
https://app.clickup.com/{workspace_id}/docs/{doc_id}/{page_id}
```

When a Markdown file has a `clickup-page` front matter field, you can pass only
the file path:

```markdown
---
clickup-page: https://app.clickup.com/123/v/dc/doc-id/page-id
---

# Page Content
```

The front matter is used for routing and is not uploaded to ClickUp.

### `clickup-update-task`

Updates a ClickUp task description from a Markdown file using the ClickUp Tasks
API. The task description is replaced with the Markdown body.

```sh
./clickup-update-task.py task.md
./clickup-update-task.py --task-id OOLE-523 task.md
./clickup-update-task.py --task-id OOLE-523 --team-id your_team_id task.md
./clickup-update-task.py task.md --no-rich-links
```

When a Markdown file has a `clickup-task-id` front matter field, you can pass
only the file path:

```markdown
---
clickup-task-id: OOLE-523
---

# Task Description
```

For custom task IDs such as `OOLE-523`, set `CLICKUP_TEAM_ID` in `.env`. You can
also use `clickup-team-id` in front matter or pass `--team-id` for one-off
overrides.

Local Markdown image and file links are uploaded as ClickUp task attachments,
then rewritten to the returned attachment URLs before the description update:

```markdown
![flow](flow.gif)
[handoff notes](handoff.pdf)
```

Remote URLs and anchors are left unchanged. Existing task attachments are not
deleted or reused, so rerunning the task updater can create duplicate
attachments in ClickUp.

## Markdown Preparation

Before uploading, the tool prepares the Markdown for ClickUp:

- Local Markdown image references are resolved relative to the Markdown file's
  folder and reported before upload. ClickUp's Docs API cannot read local files,
  so the tool stops when it finds references like `![flow](feature-flow.gif)`.
- Bare ClickUp Doc URLs are converted to Markdown links. When the linked page
  can be fetched, the link text uses the actual ClickUp page name.
- Bare Figma URLs are converted to Markdown links. When Figma oEmbed metadata
  is publicly available, standalone Figma links become linked preview images.

ClickUp's public Docs API does not expose a Doc page file upload endpoint. Use
hosted media URLs in Markdown, or add media manually in the ClickUp UI after
the text upload. Use `--allow-local-media` only when you intentionally want to
upload Markdown that still contains local media paths.

For local development, the scripts read `CLICKUP_API_TOKEN` and
`CLICKUP_TEAM_ID` from a `.env` file in this repo:

```sh
CLICKUP_API_TOKEN=pk_your_personal_api_token
CLICKUP_TEAM_ID=your_team_id
```

## Project Layout

```text
.
├── clickup-update-page.py      # Compatibility wrapper for direct local use
├── clickup-update-task.py      # Compatibility wrapper for task descriptions
├── pyproject.toml              # Package metadata and console script
├── src/clickup_tools/          # Importable Python package
└── tests/                      # Standard-library unittest tests
```

## Development

Run the test suite:

```sh
python3 -m unittest
```

Install locally in editable mode if you want the console commands on your PATH:

```sh
python3 -m pip install -e .
```

The ClickUp token is read from `CLICKUP_API_TOKEN`. Custom task IDs also use
`CLICKUP_TEAM_ID`.
