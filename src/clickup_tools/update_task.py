"""Update a ClickUp task description from a Markdown file."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import mimetypes
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Sequence
from uuid import uuid4

from .update_page import (
    BOLD,
    CYAN,
    GREEN,
    RED,
    RESET,
    extract_title,
    LinkContext,
    get_api_token,
    get_env_value,
    is_local_asset_reference,
    linkify_bare_urls,
    normalize_markdown_url,
    parse_front_matter,
    read_markdown,
    resolve_asset_path,
)


_TASK_URL_RE = re.compile(r"app\.clickup\.com/t/(?:[^/]+/)?([^/?#]+)")
_CUSTOM_TASK_ID_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")
_MARKDOWN_LINK_OR_IMAGE_RE = re.compile(
    r"(!?\[[^\]]*\]\()(<[^>\n]+>|[^)\s\n]+)([^)\n]*\))"
)


def ok(message: str) -> None:
    print(f"{GREEN}[ok]{RESET} {message}")


def err(message: str) -> None:
    print(f"{RED}[error]{RESET} {message}", file=sys.stderr)


def info(message: str) -> None:
    print(f"{CYAN}->{RESET} {message}")


@dataclass(frozen=True)
class TaskDestination:
    """Resolved destination for a ClickUp task update."""

    task_id: str
    team_id: str = ""
    custom_task_id: bool = False


@dataclass(frozen=True)
class LocalAttachment:
    """A local file referenced by Markdown content."""

    target: str
    path: Path


@dataclass
class PreparedTaskContent:
    """Markdown content after ClickUp task-oriented preprocessing."""

    content: str
    attachments: list[LocalAttachment]
    uploaded_attachments: dict[Path, str]
    title: str | None = None
    normalized_links: int = 0


def build_parser() -> argparse.ArgumentParser:
    """Create the command-line parser."""
    parser = argparse.ArgumentParser(
        prog="clickup-update-task",
        description="Update a ClickUp task description from a markdown file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  clickup-update-task notes.md
  clickup-update-task --task-id OOLE-523 notes.md
  clickup-update-task --task-id OOLE-523 --team-id 1234567890 notes.md
  clickup-update-task notes.md --no-rich-links

metadata:
  When no task ID is provided, the destination is read from front matter:
    ---
    clickup-task-id: OOLE-523
    ---

  For custom task IDs, set CLICKUP_TEAM_ID in .env, or override with:
    clickup-team-id: 1234567890

authentication:
  export CLICKUP_API_TOKEN=pk_...
  https://app.clickup.com/settings/apps
""",
    )
    parser.add_argument("file", nargs="?", metavar="FILE", help="Markdown file to upload")
    parser.add_argument("--task-id", metavar="ID", help="ClickUp task ID or task URL")
    parser.add_argument("--team-id", metavar="ID", help="ClickUp team/workspace ID")
    parser.add_argument(
        "--no-rich-links",
        action="store_true",
        help="Do not rewrite bare ClickUp/Figma URLs into Markdown links/previews",
    )
    return parser


def parse_task_id(value: str) -> str:
    """Parse a ClickUp task ID from an ID string or task URL."""
    stripped = value.strip()
    match = _TASK_URL_RE.search(stripped)
    if match:
        return urllib.parse.unquote(match.group(1))
    return stripped


def is_custom_task_id(task_id: str) -> bool:
    """Return whether a task ID looks like a ClickUp custom task ID."""
    return bool(_CUSTOM_TASK_ID_RE.match(task_id.strip()))


def resolve_destination(
    markdown_file: str,
    *,
    task_id: str = "",
    team_id: str = "",
) -> TaskDestination:
    """Resolve the task destination from CLI args, metadata, and environment."""
    metadata: dict[str, str] = {}
    if not task_id or not team_id:
        content = read_markdown(markdown_file)
        metadata, _body = parse_front_matter(content)

    resolved_task_id = parse_task_id(task_id or metadata.get("clickup-task-id", ""))
    if not resolved_task_id:
        raise ValueError(
            f"No clickup-task-id metadata found in {markdown_file!r}. "
            "Add front matter like: clickup-task-id: OOLE-523"
        )

    custom_task_id = is_custom_task_id(resolved_task_id)
    resolved_team_id = (
        team_id.strip()
        or metadata.get("clickup-team-id", "").strip()
        or get_env_value("CLICKUP_TEAM_ID").strip()
    )
    if custom_task_id and not resolved_team_id:
        raise ValueError(
            "CLICKUP_TEAM_ID is required when using a custom task ID. "
            "Add CLICKUP_TEAM_ID=1234567890 to .env or pass --team-id."
        )

    return TaskDestination(
        task_id=resolved_task_id,
        team_id=resolved_team_id,
        custom_task_id=custom_task_id,
    )


def build_task_url(task_id: str, team_id: str = "") -> str:
    """Build a browser URL for a ClickUp task."""
    if team_id:
        return f"https://app.clickup.com/t/{team_id}/{task_id}"
    return f"https://app.clickup.com/t/{task_id}"


def task_query(destination: TaskDestination) -> str:
    """Build the ClickUp query string for custom task IDs."""
    if not destination.custom_task_id:
        return ""

    query = urllib.parse.urlencode(
        {
            "custom_task_ids": "true",
            "team_id": destination.team_id,
        }
    )
    return f"?{query}"


def get_task(destination: TaskDestination, api_token: str) -> dict[str, Any]:
    """Fetch a ClickUp task."""
    url = f"https://api.clickup.com/api/v2/task/{destination.task_id}{task_query(destination)}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": api_token,
            "Accept": "application/json",
        },
        method="GET",
    )

    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read())


def extract_internal_task_id(task: dict[str, Any], fallback: str) -> str:
    """Extract the internal task ID from a ClickUp task response."""
    value = task.get("id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return fallback


def resolve_attachment_destination(
    destination: TaskDestination,
    api_token: str,
) -> TaskDestination:
    """Resolve custom task IDs to internal task IDs for attachment uploads."""
    if not destination.custom_task_id:
        return destination

    task = get_task(destination, api_token)
    return TaskDestination(
        task_id=extract_internal_task_id(task, destination.task_id),
        team_id=destination.team_id,
        custom_task_id=False,
    )


def update_task_description(
    destination: TaskDestination,
    content: str,
    api_token: str,
    name: str | None = None,
) -> dict[str, Any]:
    """Call the ClickUp API to replace a task description with Markdown content."""
    url = f"https://api.clickup.com/api/v2/task/{destination.task_id}{task_query(destination)}"
    payload_data = {"markdown_content": content}
    if name:
        payload_data["name"] = name
    payload = json.dumps(payload_data).encode("utf-8")
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


def upload_task_attachment(
    destination: TaskDestination,
    path: Path,
    api_token: str,
) -> str:
    """Upload one local file to a ClickUp task and return its public URL."""
    boundary = f"----clickup-tools-{uuid4().hex}"
    body = build_multipart_body(path, boundary)
    url = f"https://api.clickup.com/api/v2/task/{destination.task_id}/attachment"
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": api_token,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )

    with urllib.request.urlopen(request) as response:
        payload = json.loads(response.read())

    attachment_url = extract_attachment_url(payload)
    if not attachment_url:
        raise ValueError(f"ClickUp did not return an attachment URL for {path}")
    return attachment_url


def build_multipart_body(path: Path, boundary: str) -> bytes:
    """Build a multipart/form-data body for ClickUp attachment upload."""
    filename = path.name
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    file_bytes = path.read_bytes()
    header = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="attachment"; filename="{escape_header_value(filename)}"\r\n'
        f"Content-Type: {content_type}\r\n"
        "\r\n"
    ).encode("utf-8")
    footer = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return header + file_bytes + footer


def escape_header_value(value: str) -> str:
    """Escape a value used in a multipart header parameter."""
    return value.replace("\\", "\\\\").replace('"', r"\"")


def extract_attachment_url(payload: dict[str, Any]) -> str:
    """Extract a usable URL from likely ClickUp attachment response shapes."""
    candidates: list[Any] = [payload]
    for key in ("attachment", "data"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            candidates.append(nested)

    attachments = payload.get("attachments")
    if isinstance(attachments, list):
        candidates.extend(item for item in attachments if isinstance(item, dict))

    for candidate in candidates:
        for key in ("url", "download_url", "attachment_url", "thumb_url"):
            value = candidate.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

    return ""


def prepare_markdown_task_content(
    markdown_path: Path,
    api_token: str,
    destination: TaskDestination,
    *,
    rich_links: bool = True,
) -> PreparedTaskContent:
    """Read Markdown, upload local references, and prepare task description."""
    raw_content = read_markdown(str(markdown_path))
    _metadata, content = parse_front_matter(raw_content)
    title, content = extract_title(content)
    attachments = find_local_attachment_references(content, markdown_path.parent)
    missing = [attachment for attachment in attachments if not attachment.path.is_file()]
    if missing:
        missing_text = "\n".join(f"  {item.target} -> {item.path}" for item in missing)
        raise FileNotFoundError(f"Referenced attachment file not found:\n{missing_text}")

    uploaded: dict[Path, str] = {}
    if attachments:
        upload_destination = resolve_attachment_destination(destination, api_token)
        for attachment in attachments:
            resolved_path = attachment.path.resolve()
            if resolved_path not in uploaded:
                uploaded[resolved_path] = upload_task_attachment(
                    upload_destination,
                    resolved_path,
                    api_token,
                )

        content = rewrite_local_attachment_references(
            content,
            markdown_path.parent,
            uploaded,
        )

    normalized_count = 0
    if rich_links:
        content, normalized_count = linkify_bare_urls(
            content,
            LinkContext(api_token=api_token),
        )

    return PreparedTaskContent(
        content=content,
        attachments=attachments,
        uploaded_attachments=uploaded,
        title=title,
        normalized_links=normalized_count,
    )


def find_local_attachment_references(
    content: str,
    markdown_dir: Path,
) -> list[LocalAttachment]:
    """Find local Markdown file references to upload as task attachments."""
    refs: list[LocalAttachment] = []
    seen: set[tuple[str, Path]] = set()

    for match in _MARKDOWN_LINK_OR_IMAGE_RE.finditer(content):
        raw_target = normalize_markdown_url(match.group(2))
        if not is_local_asset_reference(raw_target):
            continue

        asset_path = resolve_asset_path(raw_target, markdown_dir)
        key = (raw_target, asset_path.resolve() if asset_path.exists() else asset_path)
        if key in seen:
            continue
        seen.add(key)
        refs.append(LocalAttachment(target=raw_target, path=asset_path))

    return refs


def rewrite_local_attachment_references(
    content: str,
    markdown_dir: Path,
    uploaded: dict[Path, str],
) -> str:
    """Rewrite local Markdown references to uploaded ClickUp attachment URLs."""

    def replace(match: re.Match[str]) -> str:
        raw_target = normalize_markdown_url(match.group(2))
        if not is_local_asset_reference(raw_target):
            return match.group(0)

        asset_path = resolve_asset_path(raw_target, markdown_dir).resolve()
        uploaded_url = uploaded.get(asset_path)
        if not uploaded_url:
            return match.group(0)

        return f"{match.group(1)}<{uploaded_url}>{match.group(3)}"

    return _MARKDOWN_LINK_OR_IMAGE_RE.sub(replace, content)


def run(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and return a process exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.file:
        parser.print_help()
        return 0

    api_token = get_api_token()
    if not api_token:
        err("CLICKUP_API_TOKEN is not set.")
        err("  export CLICKUP_API_TOKEN=pk_...")
        err("  Or add it to a local .env file.")
        err("  Get yours at: https://app.clickup.com/settings/apps")
        return 1

    try:
        destination = resolve_destination(
            args.file,
            task_id=args.task_id or "",
            team_id=args.team_id or "",
        )
    except (FileNotFoundError, ValueError) as exc:
        err(str(exc))
        return 1

    markdown_path = Path(args.file)
    try:
        prepared = prepare_markdown_task_content(
            markdown_path,
            api_token,
            destination,
            rich_links=not args.no_rich_links,
        )
    except (FileNotFoundError, ValueError) as exc:
        err(str(exc))
        return 1
    except urllib.error.HTTPError as exc:
        return report_http_error(exc)
    except urllib.error.URLError as exc:
        err(f"Network error: {exc.reason}")
        return 1

    info(f"File        : {markdown_path.resolve()} ({len(prepared.content):,} chars)")
    if destination.custom_task_id:
        info(f"Target      : task={destination.task_id}  team={destination.team_id}")
    else:
        info(f"Target      : task={destination.task_id}")
    info(f"Attachments : uploaded={len(prepared.uploaded_attachments)}")
    if prepared.title:
        info(f"Title       : {prepared.title}")
    for path, url in prepared.uploaded_attachments.items():
        info(f"Attachment  : {path.name} -> {url}")
    if not args.no_rich_links:
        info(f"Links       : normalized={prepared.normalized_links}")
    print()

    try:
        update_task_description(destination, prepared.content, api_token, name=prepared.title)
    except urllib.error.HTTPError as exc:
        return report_http_error(exc)
    except urllib.error.URLError as exc:
        err(f"Network error: {exc.reason}")
        return 1
    except Exception as exc:
        err(f"Unexpected error: {exc}")
        return 1

    task_url = build_task_url(destination.task_id, destination.team_id)
    print()
    ok("Task description updated")
    ok(f"URL: {BOLD}{task_url}{RESET}")
    return 0


def report_http_error(exc: urllib.error.HTTPError) -> int:
    """Print a readable ClickUp HTTP error and return a failing exit code."""
    body = exc.read().decode(errors="replace")
    err(f"API error {exc.code} {exc.reason}")
    try:
        detail = json.loads(body)
        err(f"  {detail.get('err', detail)}")
    except Exception:
        err(f"  {body[:300]}")
    return 1


def main(argv: Sequence[str] | None = None) -> None:
    """CLI entry point."""
    raise SystemExit(run(argv))
