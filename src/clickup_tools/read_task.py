"""Read selected ClickUp task details."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import re
import sys
import urllib.error
import urllib.parse
from typing import Any, Sequence

from .update_page import BOLD, RESET
from .update_task import (
    _DEFAULT_OUTCOME_FIELD_ID,
    TaskDestination,
    build_task_url,
    err,
    get_api_token,
    get_env_value,
    get_task,
    info,
    is_custom_task_id,
    ok,
    parse_task_id,
    report_http_error,
)

_TASK_URL_WITH_TEAM_RE = re.compile(r"app\.clickup\.com/t/([^/?#]+)/([^/?#]+)")


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
    tags = task.get("tags")
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
    return "\n".join(lines)


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

    if destination.custom_task_id:
        info(f"Target: task={destination.task_id}  team={destination.team_id}")
    else:
        info(f"Target: task={destination.task_id}")

    try:
        task = get_task(destination, api_token)
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
    print(render_task_details(details))
    print()
    ok(f"URL: {BOLD}{build_task_url(destination.task_id, destination.team_id)}{RESET}")
    return 0


def main(argv: Sequence[str] | None = None) -> None:
    """CLI entry point."""
    raise SystemExit(run(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
