# ClickUp Tools

Small command-line utilities for ClickUp workflows.

## Tools

### `clickup-update-page`

Updates a ClickUp Doc page from a Markdown file using the ClickUp Docs API.

```sh
export CLICKUP_API_TOKEN=pk_...

./clickup-update-page.py notes.md
./clickup-update-page.py 'https://app.clickup.com/123/v/dc/doc-id/page-id' notes.md
./clickup-update-page.py --workspace-id 123 --doc-id doc-id --page-id page-id notes.md
./clickup-update-page.py 'https://app.clickup.com/123/v/dc/doc-id/page-id' notes.md --append
./clickup-update-page.py 'https://app.clickup.com/123/v/dc/doc-id/page-id' notes.md --no-open
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

For local development, the script also reads `CLICKUP_API_TOKEN` from a `.env`
file in this repo:

```sh
CLICKUP_API_TOKEN=pk_your_personal_api_token
```

## Project Layout

```text
.
├── clickup-update-page.py      # Compatibility wrapper for direct local use
├── pyproject.toml              # Package metadata and console script
├── src/clickup_tools/          # Importable Python package
└── tests/                      # Standard-library unittest tests
```

## Development

Run the test suite:

```sh
python3 -m unittest
```

Install locally in editable mode if you want the `clickup-update-page` command on your PATH:

```sh
python3 -m pip install -e .
```

The ClickUp token is read from `CLICKUP_API_TOKEN`.
