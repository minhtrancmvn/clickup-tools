"""Update a ClickUp Doc page from a Markdown file."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Sequence


GREEN = "\033[92m"
RED = "\033[91m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


def ok(message: str) -> None:
    print(f"{GREEN}[ok]{RESET} {message}")


def err(message: str) -> None:
    print(f"{RED}[error]{RESET} {message}", file=sys.stderr)


def info(message: str) -> None:
    print(f"{CYAN}->{RESET} {message}")


_URL_PATTERNS = [
    re.compile(r"app\.clickup\.com/([^/]+)/v/dc/([^/?#]+)/([^/?#]+)"),
    re.compile(r"app\.clickup\.com/([^/]+)/docs/([^/?#]+)/([^/?#]+)"),
]


def parse_page_url(url: str) -> tuple[str, str, str]:
    """Return (workspace_id, doc_id, page_id) parsed from a ClickUp page URL."""
    for pattern in _URL_PATTERNS:
        match = pattern.search(url)
        if match:
            return match.group(1), match.group(2), match.group(3)

    raise ValueError(
        f"Cannot parse ClickUp page URL: {url!r}\n"
        "Expected: https://app.clickup.com/<workspace_id>/v/dc/<doc_id>/<page_id>"
    )


def build_page_url(workspace_id: str, doc_id: str, page_id: str) -> str:
    """Build a canonical ClickUp Doc page URL."""
    return f"https://app.clickup.com/{workspace_id}/v/dc/{doc_id}/{page_id}"


def update_page(
    workspace_id: str,
    doc_id: str,
    page_id: str,
    content: str,
    api_token: str,
    edit_mode: str = "replace",
) -> dict[str, Any]:
    """Call the ClickUp Docs API to update a page."""
    url = (
        f"https://api.clickup.com/api/v3/workspaces/{workspace_id}"
        f"/docs/{doc_id}/pages/{page_id}"
    )
    payload = json.dumps(
        {
            "content": content,
            "content_format": "text/md",
            "content_edit_mode": edit_mode,
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": api_token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="PUT",
    )

    with urllib.request.urlopen(request) as response:
        body = response.read()

    if not body:
        return {}
    return json.loads(body)


def build_parser() -> argparse.ArgumentParser:
    """Create the command-line parser."""
    parser = argparse.ArgumentParser(
        prog="clickup-update-page",
        description="Update a ClickUp Doc page from a markdown file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  clickup-update-page notes.md
  clickup-update-page 'https://app.clickup.com/123/v/dc/abc/xyz' notes.md
  clickup-update-page --workspace-id 123 --doc-id abc --page-id xyz notes.md
  clickup-update-page <url> notes.md --append
  clickup-update-page <url> notes.md --no-open

metadata:
  When no URL or IDs are provided, the destination is read from front matter:
    ---
    clickup-page: https://app.clickup.com/123/v/dc/abc/xyz
    ---

authentication:
  export CLICKUP_API_TOKEN=pk_...
  https://app.clickup.com/settings/apps
""",
    )
    parser.add_argument(
        "url_or_file",
        nargs="?",
        metavar="URL_OR_FILE",
        help="ClickUp page URL, or markdown file with clickup-page metadata",
    )
    parser.add_argument(
        "file",
        nargs="?",
        metavar="FILE",
        help="Markdown file to upload when URL is the first positional argument",
    )
    parser.add_argument("--workspace-id", metavar="ID", help="ClickUp workspace ID")
    parser.add_argument("--doc-id", metavar="ID", help="ClickUp doc ID")
    parser.add_argument("--page-id", metavar="ID", help="ClickUp page ID")

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--append",
        action="store_true",
        help="Append content instead of replacing it",
    )
    mode.add_argument(
        "--prepend",
        action="store_true",
        help="Prepend content instead of replacing it",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Do not open the page in a browser after a successful update",
    )
    return parser


def resolve_args(args: argparse.Namespace) -> tuple[str, str, str, str]:
    """Return (workspace_id, doc_id, page_id, markdown_file_path)."""
    if args.workspace_id and args.doc_id and args.page_id:
        markdown_file = args.url_or_file or args.file
        if not markdown_file:
            raise ValueError("Markdown file path is required.")
        return args.workspace_id, args.doc_id, args.page_id, markdown_file

    if args.url_or_file and args.url_or_file.startswith("http"):
        if not args.file:
            raise ValueError("Markdown file path is required after the URL.")
        workspace_id, doc_id, page_id = parse_page_url(args.url_or_file)
        return workspace_id, doc_id, page_id, args.file

    if args.url_or_file and not args.file:
        workspace_id, doc_id, page_id = read_clickup_page_from_metadata(args.url_or_file)
        return workspace_id, doc_id, page_id, args.url_or_file

    raise ValueError(
        "Provide either a ClickUp page URL followed by a markdown file, "
        "a markdown file with clickup-page metadata, "
        "or use --workspace-id / --doc-id / --page-id."
    )


def get_edit_mode(args: argparse.Namespace) -> str:
    """Resolve the ClickUp content edit mode from parsed arguments."""
    if args.append:
        return "append"
    if args.prepend:
        return "prepend"
    return "replace"


def parse_front_matter(content: str) -> tuple[dict[str, str], str]:
    """Parse simple YAML-style front matter from Markdown content."""
    lines = content.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return {}, content

    closing_index = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            closing_index = index
            break

    if closing_index is None:
        return {}, content

    metadata: dict[str, str] = {}
    for line in lines[1:closing_index]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or ":" not in stripped:
            continue

        key, value = stripped.split(":", 1)
        metadata[key.strip()] = clean_metadata_value(value)

    body = "".join(lines[closing_index + 1 :])
    return metadata, body


def clean_metadata_value(value: str) -> str:
    """Normalize a scalar front matter value."""
    cleaned = value.strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {"'", '"'}:
        return cleaned[1:-1]
    return cleaned


def read_clickup_page_from_metadata(path: str) -> tuple[str, str, str]:
    """Read clickup-page front matter from a Markdown file."""
    content = read_markdown(path)
    metadata, _body = parse_front_matter(content)
    page_url = metadata.get("clickup-page")

    if not page_url:
        raise ValueError(
            f"No clickup-page metadata found in {path!r}. "
            "Add front matter like: clickup-page: https://app.clickup.com/<workspace_id>/v/dc/<doc_id>/<page_id>"
        )

    return parse_page_url(page_url)


def get_api_token() -> str:
    """Read the ClickUp API token from the environment or a local .env file."""
    token = os.environ.get("CLICKUP_API_TOKEN", "").strip()
    if token:
        return token

    for env_path in get_env_file_candidates():
        token = read_api_token_from_env_file(env_path)
        if token:
            return token

    return ""


def get_env_file_candidates() -> list[Path]:
    """Return .env locations worth checking for local development."""
    candidates = [Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"]
    deduped: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in seen:
            seen.add(resolved)
            deduped.append(candidate)
    return deduped


def read_api_token_from_env_file(path: Path) -> str:
    """Read CLICKUP_API_TOKEN from a dotenv-style file."""
    if not path.exists():
        return ""

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        if stripped.startswith("export "):
            stripped = stripped.removeprefix("export ").strip()

        key, separator, value = stripped.partition("=")
        if separator and key.strip() == "CLICKUP_API_TOKEN":
            return clean_metadata_value(value)

    return ""


def read_markdown(path: str, strip_metadata: bool = False) -> str:
    """Read a Markdown file as UTF-8 text."""
    markdown_path = Path(path)
    if not markdown_path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    content = markdown_path.read_text(encoding="utf-8")
    if strip_metadata:
        _metadata, body = parse_front_matter(content)
        return body
    return content


def run(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and return a process exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.url_or_file:
        parser.print_help()
        return 0

    try:
        workspace_id, doc_id, page_id, markdown_file = resolve_args(args)
    except (FileNotFoundError, ValueError) as exc:
        err(str(exc))
        return 1

    api_token = get_api_token()
    if not api_token:
        err("CLICKUP_API_TOKEN is not set.")
        err("  export CLICKUP_API_TOKEN=pk_...")
        err("  Or add it to a local .env file.")
        err("  Get yours at: https://app.clickup.com/settings/apps")
        return 1

    markdown_path = Path(markdown_file)
    try:
        content = read_markdown(markdown_file, strip_metadata=True)
    except FileNotFoundError as exc:
        err(str(exc))
        return 1

    info(f"File   : {markdown_path.resolve()} ({len(content):,} chars)")
    info(f"Target : workspace={workspace_id}  doc={doc_id}  page={page_id}")

    edit_mode = get_edit_mode(args)
    info(f"Mode   : {edit_mode}")
    print()

    try:
        update_page(workspace_id, doc_id, page_id, content, api_token, edit_mode)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        err(f"API error {exc.code} {exc.reason}")
        try:
            detail = json.loads(body)
            err(f"  {detail.get('err', detail)}")
        except Exception:
            err(f"  {body[:300]}")
        return 1
    except urllib.error.URLError as exc:
        err(f"Network error: {exc.reason}")
        return 1
    except Exception as exc:
        err(f"Unexpected error: {exc}")
        return 1

    page_url = build_page_url(workspace_id, doc_id, page_id)
    print()
    ok(f"Page updated ({edit_mode})")
    ok(f"URL: {BOLD}{page_url}{RESET}")

    if not args.no_open:
        info("Opening in browser...")
        webbrowser.open(page_url)

    return 0


def main(argv: Sequence[str] | None = None) -> None:
    """CLI entry point."""
    raise SystemExit(run(argv))
