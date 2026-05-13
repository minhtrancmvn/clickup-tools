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
