"""Read selected ClickUp task details."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Sequence

from .update_page import BOLD, RESET
from .update_task import (
    _DEFAULT_OUTCOME_FIELD_ID,
    TaskDestination,
    build_task_url,
    err,
    get_api_token,
    get_env_value,
    info,
    is_custom_task_id,
    ok,
    parse_task_id,
    report_http_error,
    task_query,
)

_TASK_URL_WITH_TEAM_RE = re.compile(r"app\.clickup\.com/t/([^/?#]+)/([^/?#]+)")


@dataclass(frozen=True)
class TimeEntry:
    """A single ClickUp time tracking entry."""

    user: str
    date: str
    duration: str
    start_ms: int | None = None
    tags: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Subtask:
    """A child task of the task being read, with its own nested subtasks."""

    task_id: str
    custom_id: str
    name: str
    status: str
    subtasks: list["Subtask"] = field(default_factory=list)


@dataclass(frozen=True)
class TaskDetails:
    """Selected task fields for display."""

    title: str
    status: str
    description: str
    time_estimate: str
    time_tracked: str
    tags: list[str]
    outcome_available: bool
    outcome: str
    time_entries: list[TimeEntry] = field(default_factory=list)
    time_entries_note: str = ""
    subtasks: list[Subtask] = field(default_factory=list)


def build_parser() -> argparse.ArgumentParser:
    """Create the command-line parser."""
    parser = argparse.ArgumentParser(
        prog="clickup-read-task",
        description="Read selected details from a ClickUp task.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  clickup-read-task --task-id OOLE-523
  clickup-read-task --task-id OOLE-523 --team-id 1234567890
  clickup-read-task https://app.clickup.com/t/1234567890/OOLE-523
  clickup-read-task --task-id OOLE-523 --json

metadata:
  When no task is provided, the task is read from CLICKUP_TASK_ID in .env.

authentication:
  export CLICKUP_API_TOKEN=pk_...
  Custom task IDs also require CLICKUP_TEAM_ID unless the task URL includes it.
""",
    )
    parser.add_argument(
        "task",
        nargs="?",
        metavar="TASK_OR_URL",
        help="ClickUp task ID, custom task ID, or task URL (defaults to CLICKUP_TASK_ID)",
    )
    parser.add_argument("--task-id", metavar="ID", help="ClickUp task ID, custom task ID, or task URL")
    parser.add_argument("--team-id", metavar="ID", help="ClickUp team/workspace ID for custom task IDs")
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output task details as JSON (AI-ready, omits status lines)",
    )
    return parser


def parse_task_identifier(value: str) -> tuple[str, str]:
    """Return (task_id, team_id) parsed from an ID string or task URL."""
    stripped = value.strip()
    match = _TASK_URL_WITH_TEAM_RE.search(stripped)
    if match:
        return urllib.parse.unquote(match.group(2)), urllib.parse.unquote(match.group(1))
    return parse_task_id(stripped), ""


def resolve_destination(task_value: str, *, team_id: str = "") -> TaskDestination:
    """Resolve a ClickUp task destination from CLI args and environment."""
    resolved_task_id, url_team_id = parse_task_identifier(task_value)
    if not resolved_task_id:
        raise ValueError("Task ID is required. Pass TASK_OR_URL or --task-id.")

    custom_task_id = is_custom_task_id(resolved_task_id)
    resolved_team_id = team_id.strip() or url_team_id.strip() or get_env_value("CLICKUP_TEAM_ID").strip()
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


def extract_task_details(task: dict[str, Any], *, outcome_field_id: str = "") -> TaskDetails:
    """Extract selected task details from a ClickUp task response."""
    outcome_available, outcome = extract_outcome_value(task, outcome_field_id=outcome_field_id)
    return TaskDetails(
        title=string_value(task.get("name")) or "Untitled",
        status=extract_status(task),
        description=extract_description(task),
        time_estimate=format_duration_ms(task.get("time_estimate")),
        time_tracked=format_duration_ms(task.get("time_spent")),
        tags=extract_tags(task),
        outcome_available=outcome_available,
        outcome=outcome,
        subtasks=extract_subtasks(task),
    )


def extract_status(task: dict[str, Any]) -> str:
    """Extract a task status label."""
    status = task.get("status")
    if isinstance(status, dict):
        return string_value(status.get("status")) or string_value(status.get("type")) or "Not set"
    return string_value(status) or "Not set"


def extract_description(task: dict[str, Any]) -> str:
    """Extract the richest available task description."""
    for key in ("markdown_description", "description", "text_content"):
        value = string_value(task.get(key))
        if value:
            return value
    return "Not set"


def format_duration_ms(value: Any) -> str:
    """Format a ClickUp millisecond duration for humans."""
    if value is None or value == "":
        return "Not set"

    try:
        milliseconds = int(value)
    except (TypeError, ValueError):
        return string_value(value) or "Not set"

    seconds = max(0, milliseconds // 1000)
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)

    parts: list[str] = []
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    if seconds and not hours:
        parts.append(f"{seconds}s")
    if not parts:
        parts.append("0m")

    return f"{' '.join(parts)} ({milliseconds:,} ms)"


def extract_tags(task: dict[str, Any]) -> list[str]:
    """Extract task tag names."""
    return tag_names(task.get("tags"))


def tag_names(tags: Any) -> list[str]:
    """Extract display names from a ClickUp tag list (dicts or strings)."""
    if not isinstance(tags, list):
        return []

    names: list[str] = []
    for tag in tags:
        if isinstance(tag, dict):
            name = string_value(tag.get("name"))
        else:
            name = string_value(tag)
        if name:
            names.append(name)
    return names


def _request_json(url: str, api_token: str) -> dict[str, Any]:
    """GET a URL and parse the JSON response."""
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


def get_task_with_subtasks(destination: TaskDestination, api_token: str) -> dict[str, Any]:
    """Fetch a ClickUp task including its (direct) subtasks.

    The default task response omits subtasks; include_subtasks=true adds a
    "subtasks" list. Kept local to read_task so the shared get_task (used by
    the update flow) is left unchanged.
    """
    params: dict[str, str] = {"include_subtasks": "true"}
    if destination.custom_task_id:
        params["custom_task_ids"] = "true"
        params["team_id"] = destination.team_id
    query = urllib.parse.urlencode(params)
    url = f"https://api.clickup.com/api/v2/task/{destination.task_id}?{query}"
    return _request_json(url, api_token)


def fetch_child_subtasks(task_id: str, api_token: str) -> list[dict[str, Any]]:
    """Fetch the direct subtasks of a task by its internal ID.

    ClickUp embeds only one level of subtasks per response, so each child must
    be fetched by ID to discover its own children. Internal task IDs do not
    require custom_task_ids/team_id.
    """
    url = f"https://api.clickup.com/api/v2/task/{task_id}?include_subtasks=true"
    task = _request_json(url, api_token)
    raw = task.get("subtasks")
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def extract_subtasks(task: dict[str, Any]) -> list[Subtask]:
    """Extract direct child tasks from a ClickUp task response (single level)."""
    subtasks = task.get("subtasks")
    if not isinstance(subtasks, list):
        return []

    extracted: list[Subtask] = []
    for item in subtasks:
        if not isinstance(item, dict):
            continue
        extracted.append(
            Subtask(
                task_id=string_value(item.get("id")),
                custom_id=string_value(item.get("custom_id")),
                name=string_value(item.get("name")) or "Untitled",
                status=extract_status(item),
            )
        )
    return extracted


# Safety cap on subtask recursion depth to avoid runaway fetches.
_MAX_SUBTASK_DEPTH = 10


def expand_subtasks(
    subtasks: list[Subtask],
    api_token: str,
    *,
    max_depth: int = _MAX_SUBTASK_DEPTH,
    _depth: int = 1,
    _visited: set[str] | None = None,
) -> list[Subtask]:
    """Recursively populate each subtask's own subtasks until the tree is exhausted.

    Each node is fetched by internal ID. A visited set guards against cycles and
    repeated fetches; max_depth bounds the recursion.
    """
    if _visited is None:
        _visited = set()

    expanded: list[Subtask] = []
    for subtask in subtasks:
        children: list[Subtask] = []
        if subtask.task_id and subtask.task_id not in _visited and _depth < max_depth:
            _visited.add(subtask.task_id)
            try:
                raw_children = fetch_child_subtasks(subtask.task_id, api_token)
            except (urllib.error.HTTPError, urllib.error.URLError):
                raw_children = []
            direct = extract_subtasks({"subtasks": raw_children})
            children = expand_subtasks(
                direct,
                api_token,
                max_depth=max_depth,
                _depth=_depth + 1,
                _visited=_visited,
            )
        expanded.append(replace(subtask, subtasks=children))
    return expanded


def get_time_entries(destination: TaskDestination, api_token: str) -> list[dict[str, Any]]:
    """Fetch ClickUp tracked time for a task (all users, all intervals).

    Uses the legacy /task/{id}/time endpoint, which returns every user's
    intervals with no date window, unlike /team/{id}/time_entries which
    defaults to the authenticated user and the last 30 days.
    """
    url = f"https://api.clickup.com/api/v2/task/{destination.task_id}/time{task_query(destination)}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": api_token,
            "Accept": "application/json",
        },
        method="GET",
    )

    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.loads(response.read())

    data = payload.get("data")
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    return []


def extract_time_entries(records: list[dict[str, Any]]) -> list[TimeEntry]:
    """Flatten per-user tracked-time records into individual interval entries.

    Each record holds a user and a list of intervals. Entries are sorted by
    start time so the output reads chronologically across users.
    """
    extracted: list[TimeEntry] = []
    for record in records:
        user = extract_entry_user(record.get("user"))
        intervals = record.get("intervals")
        if not isinstance(intervals, list):
            continue
        for interval in intervals:
            if not isinstance(interval, dict):
                continue
            extracted.append(
                TimeEntry(
                    user=user,
                    date=format_epoch_ms(interval.get("start")),
                    duration=format_duration_ms(interval.get("time")),
                    start_ms=parse_epoch_ms(interval.get("start")),
                    tags=tag_names(interval.get("tags")),
                )
            )

    extracted.sort(key=lambda entry: entry.start_ms if entry.start_ms is not None else 0)
    return extracted


def extract_entry_user(user: Any) -> str:
    """Extract a display name for a time entry user."""
    if isinstance(user, dict):
        for key in ("username", "name", "email"):
            value = string_value(user.get(key))
            if value:
                return value
        user_id = string_value(user.get("id"))
        if user_id:
            return f"User {user_id}"
    return "Unknown"


def parse_epoch_ms(value: Any) -> int | None:
    """Parse a ClickUp epoch-millisecond timestamp into an int."""
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def format_epoch_ms(value: Any) -> str:
    """Format a ClickUp epoch-millisecond timestamp as a UTC date-time."""
    milliseconds = parse_epoch_ms(value)
    if milliseconds is None:
        return string_value(value) or "Unknown date"

    moment = datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc)
    return moment.strftime("%Y-%m-%d %H:%M UTC")


def extract_outcome_value(task: dict[str, Any], *, outcome_field_id: str = "") -> tuple[bool, str]:
    """Return (available, value) for the Outcome custom field."""
    fields = task.get("custom_fields")
    if not isinstance(fields, list):
        return False, ""

    wanted_field_id = outcome_field_id.strip() or get_env_value("CLICKUP_OUTCOME_FIELD_ID").strip() or _DEFAULT_OUTCOME_FIELD_ID
    for field in fields:
        if not isinstance(field, dict):
            continue

        field_id = string_value(field.get("id"))
        name = string_value(field.get("name"))
        if name.lower() != "outcome" and field_id != wanted_field_id:
            continue

        value = format_custom_field_value(field.get("value"), field)
        return True, value or "Not set"

    return False, ""


def format_custom_field_value(value: Any, field: dict[str, Any]) -> str:
    """Format a ClickUp custom field value."""
    if value is None or value == "":
        return ""

    option_names = option_name_lookup(field)
    if isinstance(value, list):
        values = [format_custom_field_item(item, option_names) for item in value]
        return ", ".join(item for item in values if item)

    return format_custom_field_item(value, option_names)


def format_custom_field_item(value: Any, option_names: dict[str, str]) -> str:
    """Format one custom field value item."""
    if isinstance(value, dict):
        for key in ("name", "username", "email", "value"):
            nested = string_value(value.get(key))
            if nested:
                return nested
        return json.dumps(value, ensure_ascii=False, sort_keys=True)

    text = string_value(value)
    if text in option_names:
        return option_names[text]
    return text


def option_name_lookup(field: dict[str, Any]) -> dict[str, str]:
    """Build a mapping of ClickUp option IDs/orders to display names."""
    type_config = field.get("type_config")
    if not isinstance(type_config, dict):
        return {}

    options = type_config.get("options")
    if not isinstance(options, list):
        return {}

    lookup: dict[str, str] = {}
    for option in options:
        if not isinstance(option, dict):
            continue
        name = string_value(option.get("name"))
        if not name:
            continue
        for key in ("id", "orderindex"):
            raw = option.get(key)
            if raw is not None:
                lookup[str(raw)] = name
    return lookup


def string_value(value: Any) -> str:
    """Return a stripped string value when possible."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    return ""


def render_task_details(details: TaskDetails) -> str:
    """Render selected task details as readable text."""
    lines = [
        f"Title: {details.title}",
        f"Status: {details.status}",
        "Description:",
        details.description,
        "",
        f"Time estimate: {details.time_estimate}",
        f"Tracked time: {details.time_tracked}",
        f"Tags: {', '.join(details.tags) if details.tags else 'None'}",
    ]
    if details.outcome_available:
        lines.extend(["Outcome:", details.outcome])

    lines.append("Time entries:")
    if details.time_entries:
        for entry in details.time_entries:
            line = f"  - {entry.date}  {entry.user}  {entry.duration}"
            if entry.tags:
                line += f"  [{', '.join(entry.tags)}]"
            lines.append(line)
    else:
        lines.append(f"  {details.time_entries_note or 'None'}")

    total = count_subtasks(details.subtasks)
    lines.append(f"Subtasks: {total}")
    lines.extend(render_subtask_lines(details.subtasks))
    return "\n".join(lines)


def count_subtasks(subtasks: list[Subtask]) -> int:
    """Count subtasks across the whole nested tree."""
    return sum(1 + count_subtasks(subtask.subtasks) for subtask in subtasks)


def render_subtask_lines(subtasks: list[Subtask], depth: int = 1) -> list[str]:
    """Render the nested subtask tree as indented text lines."""
    lines: list[str] = []
    indent = "  " * depth
    for subtask in subtasks:
        label = subtask.custom_id or subtask.task_id
        lines.append(f"{indent}- {label}  {subtask.name}  ({subtask.status})")
        lines.extend(render_subtask_lines(subtask.subtasks, depth + 1))
    return lines


def details_to_dict(details: TaskDetails, *, url: str = "") -> dict[str, Any]:
    """Build an AI-ready, JSON-serialisable mapping of task details."""
    data: dict[str, Any] = {
        "title": details.title,
        "status": details.status,
        "description": details.description,
        "time_estimate": details.time_estimate,
        "tracked_time": details.time_tracked,
        "tags": list(details.tags),
        "outcome": details.outcome if details.outcome_available else None,
        "time_entries": [
            {
                "user": entry.user,
                "date": entry.date,
                "duration": entry.duration,
                "start_ms": entry.start_ms,
                "tags": list(entry.tags),
            }
            for entry in details.time_entries
        ],
    }
    if not details.time_entries and details.time_entries_note:
        data["time_entries_note"] = details.time_entries_note
    data["has_subtasks"] = bool(details.subtasks)
    data["subtask_count"] = count_subtasks(details.subtasks)
    data["subtasks"] = [subtask_to_dict(subtask) for subtask in details.subtasks]
    if url:
        data["url"] = url
    return data


def subtask_to_dict(subtask: Subtask) -> dict[str, Any]:
    """Build a JSON-serialisable mapping for a subtask and its nested subtasks."""
    return {
        "task_id": subtask.task_id,
        "custom_id": subtask.custom_id or None,
        "name": subtask.name,
        "status": subtask.status,
        "subtasks": [subtask_to_dict(child) for child in subtask.subtasks],
    }


def render_task_json(details: TaskDetails, *, url: str = "") -> str:
    """Render task details as a JSON document."""
    return json.dumps(details_to_dict(details, url=url), ensure_ascii=False, indent=2)


def run(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and return a process exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)
    task_value = args.task_id or args.task or get_env_value("CLICKUP_TASK_ID").strip()

    if not task_value:
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
        destination = resolve_destination(task_value, team_id=args.team_id or "")
    except ValueError as exc:
        err(str(exc))
        return 1

    if not args.json:
        if destination.custom_task_id:
            info(f"Target: task={destination.task_id}  team={destination.team_id}")
        else:
            info(f"Target: task={destination.task_id}")

    try:
        task = get_task_with_subtasks(destination, api_token)
    except urllib.error.HTTPError as exc:
        return report_http_error(exc)
    except urllib.error.URLError as exc:
        err(f"Network error: {exc.reason}")
        return 1
    except Exception as exc:
        err(f"Unexpected error: {exc}")
        return 1

    outcome_field_id = get_env_value("CLICKUP_OUTCOME_FIELD_ID").strip() or _DEFAULT_OUTCOME_FIELD_ID
    details = extract_task_details(task, outcome_field_id=outcome_field_id)

    if details.subtasks:
        try:
            details = replace(details, subtasks=expand_subtasks(details.subtasks, api_token))
        except (urllib.error.HTTPError, urllib.error.URLError):
            pass  # Keep the direct subtasks already extracted.

    try:
        raw_records = get_time_entries(destination, api_token)
        details = replace(details, time_entries=extract_time_entries(raw_records))
    except urllib.error.HTTPError as exc:
        details = replace(details, time_entries_note=f"Unavailable (API error {exc.code})")
    except urllib.error.URLError as exc:
        details = replace(details, time_entries_note=f"Unavailable (network error: {exc.reason})")
    except Exception as exc:
        details = replace(details, time_entries_note=f"Unavailable ({exc})")

    task_url = build_task_url(destination.task_id, destination.team_id)
    if args.json:
        print(render_task_json(details, url=task_url))
    else:
        print(render_task_details(details))
        print()
        ok(f"URL: {BOLD}{task_url}{RESET}")
    return 0


def main(argv: Sequence[str] | None = None) -> None:
    """CLI entry point."""
    raise SystemExit(run(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
