"""Update a ClickUp Doc page from a Markdown file."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
import re
import sys
import urllib.error
import urllib.parse
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
ENV_FILE_ENV_VAR = "CLICKUP_TOOLS_ENV_FILE"
_MARKDOWN_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\((<[^>\n]+>|[^)\s\n]+)([^)\n]*)\)")
_URL_RE = re.compile(r"https?://[^\s<>\]]+")
_TRAILING_URL_PUNCTUATION = ".,;:"


@dataclass
class PreparedContent:
    """Markdown content after ClickUp-oriented preprocessing."""

    content: str
    local_media_refs: list[str] = field(default_factory=list)
    normalized_links: int = 0


@dataclass
class LinkContext:
    """Caches metadata lookups while linkifying one document."""

    api_token: str
    clickup_titles: dict[str, str] = field(default_factory=dict)
    figma_oembed: dict[str, dict[str, Any]] = field(default_factory=dict)


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


def extract_title(content: str) -> tuple[str | None, str]:
    """Return (title, body) where the leading H1 line is stripped from body.

    If no H1 is found, returns (None, content) unchanged.
    """
    lines = content.split("\n")
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            # Drop the H1 line and any immediately following blank line
            remaining = lines[i + 1 :]
            if remaining and remaining[0].strip() == "":
                remaining = remaining[1:]
            return title, "\n".join(remaining)
    return None, content


def update_page(
    workspace_id: str,
    doc_id: str,
    page_id: str,
    content: str,
    api_token: str,
    edit_mode: str = "replace",
    name: str | None = None,
) -> dict[str, Any]:
    """Call the ClickUp Docs API to update a page."""
    url = (
        f"https://api.clickup.com/api/v3/workspaces/{workspace_id}"
        f"/docs/{doc_id}/pages/{page_id}"
    )
    data: dict[str, Any] = {
        "content": content,
        "content_format": "text/md",
        "content_edit_mode": edit_mode,
    }
    if name is not None:
        data["name"] = name
    payload = json.dumps(data).encode("utf-8")

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


def get_page(
    workspace_id: str,
    doc_id: str,
    page_id: str,
    api_token: str,
) -> dict[str, Any]:
    """Fetch a ClickUp Doc page."""
    query = urllib.parse.urlencode({"content_format": "text/plain"})
    url = (
        f"https://api.clickup.com/api/v3/workspaces/{workspace_id}"
        f"/docs/{doc_id}/pages/{page_id}?{query}"
    )
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
  clickup-update-page notes.md --no-rich-links
  clickup-update-page notes.md --allow-local-media

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
    parser.add_argument(
        "--no-rich-links",
        action="store_true",
        help="Do not rewrite bare ClickUp/Figma URLs into Markdown links/previews",
    )
    parser.add_argument(
        "--allow-local-media",
        action="store_true",
        help="Update even when Markdown contains local media paths that ClickUp cannot render",
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
    return get_env_value("CLICKUP_API_TOKEN")


def get_env_file_candidates() -> list[Path]:
    """Return .env locations worth checking for local development."""
    candidates: list[Path] = []
    explicit_env_file = os.environ.get(ENV_FILE_ENV_VAR, "").strip()
    if explicit_env_file:
        candidates.append(Path(explicit_env_file).expanduser())

    candidates.extend([Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"])
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
    return read_value_from_env_file(path, "CLICKUP_API_TOKEN")


def get_env_value(name: str) -> str:
    """Read a value from the environment or a local .env file."""
    value = os.environ.get(name, "").strip()
    if value:
        return value

    for env_path in get_env_file_candidates():
        value = read_value_from_env_file(env_path, name)
        if value:
            return value

    return ""


def read_value_from_env_file(path: Path, name: str) -> str:
    """Read one variable from a dotenv-style file."""
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
        if separator and key.strip() == name:
            return clean_metadata_value(value)

    return ""


def prepare_markdown_content(
    markdown_path: Path,
    api_token: str,
    *,
    rich_links: bool = True,
) -> PreparedContent:
    """Read Markdown and prepare it for the ClickUp Docs API."""
    raw_content = read_markdown(str(markdown_path))
    _metadata, content = parse_front_matter(raw_content)
    prepared = PreparedContent(content=content)
    prepared.local_media_refs = find_local_media_references(
        prepared.content,
        markdown_path.parent,
    )

    if rich_links:
        linkified, normalized_count = linkify_bare_urls(
            prepared.content,
            LinkContext(api_token=api_token),
        )
        prepared.content = linkified
        prepared.normalized_links = normalized_count

    return prepared


def find_local_media_references(
    content: str,
    markdown_dir: Path,
) -> list[str]:
    """Find local Markdown media references ClickUp cannot render from API uploads."""
    refs: list[str] = []
    for match in _MARKDOWN_IMAGE_RE.finditer(content):
        raw_target = normalize_markdown_url(match.group(2))

        if not is_local_asset_reference(raw_target):
            continue

        asset_path = resolve_asset_path(raw_target, markdown_dir)
        if not asset_path.exists() or not asset_path.is_file():
            refs.append(f"{raw_target} (file not found)")
        else:
            refs.append(str(asset_path))

    return refs


def normalize_markdown_url(raw_url: str) -> str:
    """Strip Markdown angle brackets from a URL/path."""
    value = raw_url.strip()
    if value.startswith("<") and value.endswith(">"):
        return value[1:-1].strip()
    return value


def is_local_asset_reference(target: str) -> bool:
    """Return whether a Markdown target is a local file reference."""
    if not target or target.startswith("#"):
        return False

    parsed = urllib.parse.urlparse(target)
    return parsed.scheme == ""


def resolve_asset_path(target: str, markdown_dir: Path) -> Path:
    """Resolve a Markdown local asset path relative to its document."""
    path = Path(urllib.parse.unquote(target)).expanduser()
    if path.is_absolute():
        return path
    return markdown_dir / path


def linkify_bare_urls(content: str, context: LinkContext) -> tuple[str, int]:
    """Convert bare ClickUp/Figma URLs into Markdown links or previews."""
    normalized_count = 0
    in_fence = False
    output: list[str] = []

    for line in content.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            output.append(line)
            continue

        if in_fence:
            output.append(line)
            continue

        line_only_url = get_single_bare_url(line)

        def replace(match: re.Match[str]) -> str:
            nonlocal normalized_count
            if is_url_already_linked(line, match):
                return match.group(0)

            url, trailing = split_trailing_url_punctuation(match.group(0))
            replacement = format_special_url(url, context, line_only_url == url)
            if replacement == url:
                return match.group(0)

            normalized_count += 1
            return replacement + trailing

        output.append(_URL_RE.sub(replace, line))

    return "".join(output), normalized_count


def get_single_bare_url(line: str) -> str | None:
    """Return the URL when a line consists of only one bare URL."""
    stripped = line.strip()
    matches = list(_URL_RE.finditer(stripped))
    if len(matches) != 1:
        return None

    url, trailing = split_trailing_url_punctuation(matches[0].group(0))
    if trailing:
        return None
    if matches[0].start() == 0 and matches[0].end() == len(stripped):
        return url
    return None


def is_url_already_linked(line: str, match: re.Match[str]) -> bool:
    """Avoid rewriting URLs already inside Markdown links or inline code."""
    start = match.start()
    prefix = line[:start]

    if prefix.endswith("](") or prefix.endswith("](<") or prefix.endswith("<"):
        return True

    return prefix.count("`") % 2 == 1


def split_trailing_url_punctuation(raw_url: str) -> tuple[str, str]:
    """Separate punctuation that belongs to the sentence, not the URL."""
    url = raw_url
    trailing = ""

    while url and url[-1] in _TRAILING_URL_PUNCTUATION:
        trailing = url[-1] + trailing
        url = url[:-1]

    while url.endswith(")") and url.count("(") < url.count(")"):
        trailing = ")" + trailing
        url = url[:-1]

    return url, trailing


def format_special_url(url: str, context: LinkContext, line_only: bool = False) -> str:
    """Format a URL that ClickUp should receive as a richer Markdown block."""
    hostname = urllib.parse.urlparse(url).hostname or ""
    if hostname.endswith("clickup.com"):
        return markdown_link(get_clickup_link_label(url, context), url)

    if hostname.endswith("figma.com"):
        return format_figma_url(url, context, line_only=line_only)

    return url


def get_clickup_link_label(url: str, context: LinkContext) -> str:
    """Resolve a ClickUp Doc URL to its page name when possible."""
    if url in context.clickup_titles:
        return context.clickup_titles[url]

    label = "ClickUp page"
    try:
        workspace_id, doc_id, page_id = parse_page_url(url)
        page = get_page(workspace_id, doc_id, page_id, context.api_token)
        label = extract_page_name(page) or label
    except Exception:
        pass

    context.clickup_titles[url] = label
    return label


def extract_page_name(page: dict[str, Any]) -> str:
    """Extract a page name from likely ClickUp response shapes."""
    for key in ("name", "title"):
        value = page.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    for container_key in ("page", "data"):
        container = page.get(container_key)
        if isinstance(container, dict):
            name = extract_page_name(container)
            if name:
                return name

    return ""


def format_figma_url(url: str, context: LinkContext, *, line_only: bool = False) -> str:
    """Create a readable Figma link, with a linked thumbnail when available."""
    metadata = get_figma_oembed(url, context)
    title = metadata.get("title") if metadata else ""
    label = str(title).strip() or infer_figma_label(url)
    thumbnail_url = str(metadata.get("thumbnail_url", "")).strip() if metadata else ""

    if line_only and thumbnail_url:
        image = markdown_image(f"Figma preview: {label}", thumbnail_url)
        return f"{markdown_link_raw_label(image, url)}\n{markdown_link(label, url)}"

    return markdown_link(label, url)


def get_figma_oembed(url: str, context: LinkContext) -> dict[str, Any]:
    """Fetch Figma oEmbed metadata when available."""
    if url in context.figma_oembed:
        return context.figma_oembed[url]

    metadata: dict[str, Any] = {}
    query = urllib.parse.urlencode({"url": url, "maxwidth": "960", "maxheight": "540"})
    request = urllib.request.Request(
        f"https://api.figma.com/v1/oembed?{query}",
        headers={"Accept": "application/json"},
        method="GET",
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read()
        loaded = json.loads(body)
        if isinstance(loaded, dict):
            metadata = loaded
    except Exception:
        metadata = {}

    context.figma_oembed[url] = metadata
    return metadata


def infer_figma_label(url: str) -> str:
    """Infer a compact Figma link label from the URL path."""
    path = urllib.parse.urlparse(url).path.lower()
    if "/proto/" in path:
        return "Figma prototype"
    if "/design/" in path:
        return "Figma design"
    if "/figjam/" in path:
        return "FigJam board"
    return "Figma"


def markdown_link(label: str, url: str) -> str:
    """Build a Markdown link with URL angle brackets for query-heavy URLs."""
    return f"[{escape_markdown_label(label)}](<{url}>)"


def markdown_link_raw_label(label: str, url: str) -> str:
    """Build a Markdown link whose label already contains Markdown."""
    return f"[{label}](<{url}>)"


def markdown_image(alt_text: str, url: str) -> str:
    """Build a Markdown image."""
    return f"![{escape_markdown_label(alt_text)}](<{url}>)"


def escape_markdown_label(label: str) -> str:
    """Escape square brackets in a Markdown label."""
    return label.replace("[", "\\[").replace("]", "\\]")


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
        prepared = prepare_markdown_content(
            markdown_path,
            api_token,
            rich_links=not args.no_rich_links,
        )
    except FileNotFoundError as exc:
        err(str(exc))
        return 1

    content = prepared.content

    info(f"File   : {markdown_path.resolve()} ({len(content):,} chars)")
    info(f"Target : workspace={workspace_id}  doc={doc_id}  page={page_id}")
    info(f"Media  : local_refs={len(prepared.local_media_refs)}")
    for local_ref in prepared.local_media_refs:
        info(f"Local  : {local_ref}")
    if not args.no_rich_links:
        info(f"Links  : normalized={prepared.normalized_links}")

    if prepared.local_media_refs and not args.allow_local_media:
        err("Local media references cannot be rendered by ClickUp Docs API uploads.")
        err("Replace them with public/hosted URLs, remove them, or rerun with --allow-local-media.")
        return 1

    edit_mode = get_edit_mode(args)
    info(f"Mode   : {edit_mode}")

    title, body = extract_title(content)
    if title:
        info(f"Title  : {title}")
    print()

    try:
        update_page(workspace_id, doc_id, page_id, body, api_token, edit_mode, name=title)
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
