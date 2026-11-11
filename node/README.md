# ClickUp Tools MCP

MCP server and command-line tools for ClickUp workflows: update Doc pages and task descriptions from Markdown, read task details as AI-ready JSON, and post task lists to Telegram.

This is the Node.js/TypeScript build of [clickup-tools](https://github.com/minhtrancmvn/clickup-tools). It behaves the same as the Python package, with the same tools, arguments, output and `.env` handling, and needs no Python install.

Requires Node.js 20 or newer.

## Credentials

The tools need a ClickUp personal API token, which you can create at https://app.clickup.com/settings/apps. `CLICKUP_TEAM_ID` is also needed for custom task IDs such as `OOLE-523`; internal task IDs work without it.

For the MCP server, set both as environment variables in your MCP client's server config, as shown below; no `.env` file is needed. For the command-line tools, export them in your shell or put them in a `.env` file in the working directory.

## MCP setup

The server speaks MCP over stdio and exposes six tools: `update_clickup_page`, `update_clickup_task`, `read_clickup_task`, `pull_clickup_page`, `pull_clickup_task` and `add_clickup_comment`.

### Claude Code

```sh
claude mcp add clickup-tools -s user \
  -e CLICKUP_API_TOKEN=pk_your_personal_api_token \
  -e CLICKUP_TEAM_ID=your_team_id \
  -- npx -y @kaishj91/clickup-tools-mcp
```

`-s user` keeps the server, token included, in your own Claude Code config. Avoid `-s project`, which writes the token into `.mcp.json` in the repository.

### VS Code / GitHub Copilot

`.vscode/mcp.json`. VS Code asks for the token when the server first starts, so the file holds no secret and is safe to commit:

```json
{
  "inputs": [
    { "type": "promptString", "id": "clickup-token", "description": "ClickUp API token", "password": true }
  ],
  "servers": {
    "clickup-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kaishj91/clickup-tools-mcp"],
      "env": {
        "CLICKUP_API_TOKEN": "${input:clickup-token}",
        "CLICKUP_TEAM_ID": "your_team_id"
      }
    }
  }
}
```

### Codex CLI

```sh
codex mcp add clickup-tools \
  --env CLICKUP_API_TOKEN=pk_your_personal_api_token \
  --env CLICKUP_TEAM_ID=your_team_id \
  -- npx -y @kaishj91/clickup-tools-mcp
```

### Claude Desktop and other clients

```json
{
  "mcpServers": {
    "clickup-tools": {
      "command": "npx",
      "args": ["-y", "@kaishj91/clickup-tools-mcp"],
      "env": {
        "CLICKUP_API_TOKEN": "pk_your_personal_api_token",
        "CLICKUP_TEAM_ID": "your_team_id"
      }
    }
  }
}
```

Put credentials in `env`, not in `args`: command-line arguments show up in process listings such as `ps` for every user on the machine, and environment variables do not. To keep them in a file instead, leave out `env` and add `"--env-file", "/absolute/path/to/.env"` to `args`.

The first `npx` start downloads the package. To start faster, install it globally with `npm install -g @kaishj91/clickup-tools-mcp` and use `clickup-tools-mcp` as the command.

### Tools

| Tool | Arguments |
| --- | --- |
| `update_clickup_page` | `file_path` (required), `no_open` (default `true`), `allow_local_media` (default `false`) |
| `update_clickup_task` | `file_path` (required), `task_id`, `team_id`, `no_rich_links` (default `false`) |
| `read_clickup_task` | `task_id` (falls back to `CLICKUP_TASK_ID`), `team_id`, `include_comments` (default `false`), `include_replies` (default `false`), `comment_limit` (1-100, default `20`) |
| `pull_clickup_page` | `page_url` (required), `file_path` (omit to get the Markdown back), `overwrite` (default `false`) |
| `pull_clickup_task` | `task_id` (falls back to `CLICKUP_TASK_ID`), `team_id`, `file_path` (omit to get the Markdown back), `overwrite` (default `false`) |
| `add_clickup_comment` | `task_id`, `team_id`, `text` or `file_path` (Markdown), `notify_all` (default `false`) |

Pass absolute Markdown paths to the update tools. `read_clickup_task` returns the same JSON document as `clickup-read-task --json`. Each tool returns text that starts with `Success.` or `Error (exit code N).` followed by the command output.

## Command-line tools

Install globally to get the commands on your `PATH`:

```sh
npm install -g @kaishj91/clickup-tools-mcp
```

Or run one without installing:

```sh
npx -y -p @kaishj91/clickup-tools-mcp clickup-read-task --help
```

Every command takes `--help`. The CLIs read credentials from the environment or from `.env` in the current directory.

### `clickup-update-page`

Updates a ClickUp Doc page from a Markdown file.

```sh
clickup-update-page notes.md
clickup-update-page 'https://app.clickup.com/123/v/dc/doc-id/page-id' notes.md
clickup-update-page --workspace-id 123 --doc-id doc-id --page-id page-id notes.md
clickup-update-page notes.md --append        # or --prepend; default replaces
clickup-update-page notes.md --no-open       # do not open the page afterwards
clickup-update-page notes.md --no-rich-links
clickup-update-page notes.md --allow-local-media
```

Supported URLs are `https://app.clickup.com/{workspace_id}/v/dc/{doc_id}/{page_id}` and `https://app.clickup.com/{workspace_id}/docs/{doc_id}/{page_id}`. With a `clickup-page` front matter field, only the file path is needed. The first `# Heading` line becomes the page title and is removed from the body, and a `subtitle` front matter field sets the page subtitle.

To create a new page, use `clickup-doc: <Doc URL>` instead of `clickup-page` (add `clickup-parent-page: <page ID or URL>` for a sub-page). The file needs a `# Page name` heading; after the page is created, its `clickup-page` URL is written back into the front matter, so the next run updates it.

### `clickup-update-task`

Replaces a task description with the Markdown body.

```sh
clickup-update-task task.md
clickup-update-task --task-id OOLE-523 task.md
clickup-update-task --task-id OOLE-523 --team-id your_team_id task.md
clickup-update-task task.md --no-rich-links
```

The first `# Heading` line becomes the task name and is removed from the description. Local image and file links such as `![flow](flow.gif)` are uploaded as task attachments and rewritten to the attachment URLs. A file that is already attached to the task with the same name and size is reused instead of uploaded again.

Front matter can also set task fields: `status`, `priority` (`urgent`, `high`, `normal`, `low`, `none` or 1-4), `points`, `time_estimate` (`2h`, `45m`, `1h 30m`), and `start_date` / `due_date` (`2026-11-20` for a date, `2026-11-20 14:00` for a local time, or an ISO timestamp with a time zone). Invalid values stop the update before anything is sent.

To create a new task, use `clickup-list: <List ID or URL>` instead of `clickup-task-id` (add `clickup-parent-task: <task ID>` to make it a subtask). The file needs a `# Task name` heading. The task is created, its `clickup-task-id` is written back into the front matter straight away (so a failure later can't create a duplicate on the next run), and then the normal update runs.

Sections headed `## Checklist` or `## Checklist: Name` become ClickUp checklists on the task and are left out of the description:

```markdown
## Checklist: QA
- [x] Smoke test
  - [ ] iOS
  - [x] Android
- [ ] Regression
```

Indent an item to nest it under the one above. Checklists and items are matched by name: missing ones are created, done/not-done state and nesting are updated, and nothing in ClickUp is deleted.

### `clickup-read-task`

Prints the title, status, description (as Markdown), time estimate, tracked time, tags, the `Outcome` custom field, assignees, priority, start and due dates, points, List, parent task, dependencies, linked tasks, attachments, time in each status (when the Time in Status ClickApp is on), time entries, checklists and the full subtask tree. Subtasks are fetched recursively, up to 10 levels deep; if part of the tree can't be loaded, the affected subtask says so instead of silently showing no children.

```sh
clickup-read-task OOLE-523
clickup-read-task 'https://app.clickup.com/t/your_team_id/OOLE-523'
clickup-read-task --task-id OOLE-523 --json
clickup-read-task --task-id OOLE-523 --json --include-comments --comment-limit 10
clickup-read-task --task-id OOLE-523 --json --include-replies
```

With no task given, it reads `CLICKUP_TASK_ID`. `--json` prints a single JSON object with `title`, `status`, `description`, `time_estimate`, `tracked_time`, `tags`, `outcome`, `assignees`, `priority`, `start_date` / `start_date_ms`, `due_date` / `due_date_ms`, `points`, `parent`, `list`, `dependencies` (`waiting_on`, `blocking`), `linked_tasks`, `attachments`, `time_in_status`, `checklists`, `time_entries`, `has_subtasks`, `subtask_count`, `subtasks`, `url` and, with `--include-comments`, `comments`. Each comment has a `reply_count`; `--include-replies` also returns each comment's threaded `replies`. `--comment-limit` accepts 1-100 (ClickUp returns 25 per page, so larger limits make more requests). When part of the subtask tree failed to load, the object has `subtasks_incomplete: true` and the affected subtask a `subtasks_note`.

### `clickup-pull-page` and `clickup-pull-task`

Save a Doc page or a task as a Markdown file you can edit and push back with `clickup-update-page` / `clickup-update-task`.

```sh
clickup-pull-page 'https://app.clickup.com/123/v/dc/doc-id/page-id' -o spec.md
clickup-pull-task OOLE-523 -o OOLE-523.md
clickup-pull-task OOLE-523 > OOLE-523.md      # without -o, the Markdown goes to standard output
```

A pulled page has `clickup-page` (and `subtitle`) front matter, the page name as a `# heading`, then the content. A pulled task has `clickup-task-id` (plus `clickup-team-id` for custom IDs), `outcome`, `status`, `priority`, `points` and `time_estimate`, the task name as a `# heading`, then the Markdown description and one `## Checklist: Name` section per checklist. Start and due dates are left out because ClickUp doesn't report whether they include a time, so pushing them back could change them. An existing file is never replaced unless you pass `--force`.

### `clickup-comment`

Posts Markdown as a task comment, converted to ClickUp's rich-text comment format.

```sh
clickup-comment OOLE-523 --text 'Deployed to **staging**, see [the run](https://ci.example/1)'
clickup-comment OOLE-523 --file update.md
clickup-comment --file update.md      # task from the file's clickup-task-id
```

Supported: `**bold**`, `*italic*`, `` `code` ``, `[links](https://...)`, bulleted, numbered and `- [ ]` checklist items (indent to nest), and fenced code blocks. Headings are posted as bold lines; other Markdown is posted as plain text. The file's front matter is not posted. Text that starts with `-` needs the `--text=- item` form.

### `clickup-send-chat`

Like `clickup-send-telegram`, but posts to a ClickUp Chat channel: an optional intro, then one numbered line per task with the task ID linked.

```sh
clickup-send-chat channels                                   # list channel IDs
clickup-send-chat send OOLE-546 OOLE-547 --intro '@dev please check' --dry-run
clickup-send-chat send OOLE-546 OOLE-547 --intro '@dev please check'
clickup-send-chat send OOLE-546 --channel-id CHANNEL_ID
```

It uses `CLICKUP_TEAM_ID` as the workspace and `CLICKUP_CHAT_CHANNEL_ID` as the default channel.

### `clickup-send-telegram`

Sends one Telegram message through a bot: an optional intro line, then one numbered line per task, with the task ID linked to ClickUp.

```sh
clickup-send-telegram chats                                    # list chat and topic IDs the bot can see
clickup-send-telegram send OOLE-546 OOLE-547 --intro "@developer" --dry-run
clickup-send-telegram send OOLE-546 OOLE-547 --intro "@developer"
clickup-send-telegram send OOLE-546 --chat-id 123456789 --thread-id 21
```

A bot can only message someone who has opened it and pressed Start. In a group, post `/start@your_bot` first. The bot token is never printed.

## Configuration

| Variable | Used for |
| --- | --- |
| `CLICKUP_API_TOKEN` | All ClickUp requests (required) |
| `CLICKUP_TEAM_ID` | Custom task IDs |
| `CLICKUP_TASK_ID` | Default task for `clickup-read-task` / `read_clickup_task` |
| `CLICKUP_OUTCOME_FIELD_ID` | ID of the `Outcome` custom field, if yours differs from the default |
| `TELEGRAM_BOT_TOKEN` | `clickup-send-telegram` |
| `TELEGRAM_CHAT_ID` | Default chat for `clickup-send-telegram send` |
| `TELEGRAM_THREAD_ID` | Default forum topic; omit to post in General |
| `CLICKUP_CHAT_CHANNEL_ID` | Default channel for `clickup-send-chat send` |
| `CLICKUP_TOOLS_ENV_FILE` | Extra `.env` path to check (set by `--env-file`) |

A variable set in the environment wins. Otherwise the file in `CLICKUP_TOOLS_ENV_FILE` is checked first, then `./.env`.

Markdown front matter routes a file to its destination and is never uploaded:

```markdown
---
clickup-page: https://app.clickup.com/123/v/dc/doc-id/page-id
clickup-task-id: OOLE-523
clickup-team-id: 1234567890
clickup-doc: https://app.clickup.com/123/v/dc/doc-id
clickup-parent-page: parent-page-id
clickup-list: https://app.clickup.com/123/v/li/901801482831
clickup-parent-task: OOLE-500
outcome: Fixed and deployed
subtitle: Draft for review
status: in progress
priority: high
points: 3
time_estimate: 1h 30m
start_date: 2026-11-20
due_date: 2026-11-25 17:00
---
```

`clickup-page`, `clickup-doc`, `clickup-parent-page` and `subtitle` are read by `clickup-update-page`; `clickup-doc` only applies when `clickup-page` is missing. `clickup-list` and `clickup-parent-task` only apply when `clickup-task-id` is missing. The other keys are read by `clickup-update-task`: `outcome` sets the task's `Outcome` custom field, and `status`, `priority`, `points`, `time_estimate`, `start_date` and `due_date` set those task fields.

All requests honour ClickUp's rate limit: when ClickUp answers HTTP 429, the tools wait for the reset time it reports (up to a minute) and retry, at most twice.

## Markdown preparation

- Bare ClickUp URLs become Markdown links. Doc page links are titled with the page name when it can be fetched; others are labelled "ClickUp page".
- Bare Figma URLs become Markdown links; a Figma URL alone on a line becomes a linked preview image when Figma provides one. `--no-rich-links` turns both off.
- Code blocks, inline code and existing links are left alone.
- The ClickUp Docs API cannot upload files, so `clickup-update-page` stops when the Markdown references local media. Use hosted URLs, or pass `--allow-local-media` to upload anyway.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Pull requests that touch `node/` run typecheck, tests and build on Node 20, 22 and 24 in GitHub Actions.

To release, bump the version and merge to `main`:

```sh
npm version patch --no-git-tag-version   # or minor / major
```

The workflow publishes to npm when the version in `package.json` is not on the registry yet; merges without a version bump skip publishing. Publishing uses npm trusted publishing, so no npm token is stored in GitHub.

## License

MIT
