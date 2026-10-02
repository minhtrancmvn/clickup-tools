from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from clickup_tools import read_task as read_task_module  # noqa: E402
from clickup_tools.read_task import (  # noqa: E402
    Subtask,
    count_subtasks,
    details_to_dict,
    expand_subtasks,
    extract_outcome_value,
    extract_subtasks,
    extract_tags,
    extract_task_details,
    extract_time_entries,
    format_duration_ms,
    format_epoch_ms,
    parse_task_identifier,
    render_task_details,
    render_task_json,
    resolve_destination,
    run,
)
from clickup_tools.mcp_server import read_clickup_task  # noqa: E402
from clickup_tools.update_task import TaskDestination  # noqa: E402


class ClickUpReadTaskTests(unittest.TestCase):
    def test_parse_task_identifier_from_url_with_team_id(self) -> None:
        self.assertEqual(
            parse_task_identifier("https://app.clickup.com/t/1234567890/OOLE-523"),
            ("OOLE-523", "1234567890"),
        )

    def test_parse_task_identifier_from_plain_id(self) -> None:
        self.assertEqual(parse_task_identifier("abc123"), ("abc123", ""))

    def test_resolve_destination_uses_team_id_from_url_for_custom_id(self) -> None:
        with patch("clickup_tools.read_task.get_env_value", return_value=""):
            destination = resolve_destination("https://app.clickup.com/t/1234567890/OOLE-523")

        self.assertEqual(
            destination,
            TaskDestination(
                task_id="OOLE-523",
                team_id="1234567890",
                custom_task_id=True,
            ),
        )

    def test_resolve_destination_requires_team_id_for_custom_id(self) -> None:
        with patch("clickup_tools.read_task.get_env_value", return_value=""):
            with self.assertRaises(ValueError):
                resolve_destination("OOLE-523")

    def test_resolve_destination_supports_internal_task_id_without_team(self) -> None:
        with patch("clickup_tools.read_task.get_env_value", return_value=""):
            destination = resolve_destination("abc123")

        self.assertEqual(destination, TaskDestination(task_id="abc123", custom_task_id=False))

    def test_format_duration_ms(self) -> None:
        self.assertEqual(format_duration_ms(None), "Not set")
        self.assertEqual(format_duration_ms(0), "0m (0 ms)")
        self.assertEqual(format_duration_ms(5_400_000), "1h 30m (5,400,000 ms)")
        self.assertEqual(format_duration_ms(45_000), "45s (45,000 ms)")

    def test_extract_tags(self) -> None:
        self.assertEqual(
            extract_tags({"tags": [{"name": "bug"}, {"name": "client"}, "urgent"]}),
            ["bug", "client", "urgent"],
        )

    def test_extract_outcome_value_by_name(self) -> None:
        available, value = extract_outcome_value(
            {
                "custom_fields": [
                    {"id": "field-1", "name": "Outcome", "value": "Fixed and deployed"},
                ]
            },
            outcome_field_id="",
        )

        self.assertTrue(available)
        self.assertEqual(value, "Fixed and deployed")

    def test_extract_outcome_value_by_configured_id_with_dropdown_option(self) -> None:
        available, value = extract_outcome_value(
            {
                "custom_fields": [
                    {
                        "id": "outcome-field",
                        "name": "Result",
                        "value": "option-1",
                        "type_config": {
                            "options": [{"id": "option-1", "name": "Done"}],
                        },
                    },
                ]
            },
            outcome_field_id="outcome-field",
        )

        self.assertTrue(available)
        self.assertEqual(value, "Done")

    def test_extract_outcome_value_absent(self) -> None:
        available, value = extract_outcome_value({"custom_fields": []}, outcome_field_id="outcome-field")

        self.assertFalse(available)
        self.assertEqual(value, "")

    def test_extract_task_details_and_render_requested_fields(self) -> None:
        details = extract_task_details(
            {
                "name": "Task Title",
                "status": {"status": "in progress"},
                "markdown_description": "## Details\nBody",
                "time_estimate": 3_600_000,
                "time_spent": 1_800_000,
                "tags": [{"name": "bug"}],
                "custom_fields": [{"name": "Outcome", "value": "Shipped"}],
            },
            outcome_field_id="",
        )
        rendered = render_task_details(details)

        self.assertIn("Title: Task Title", rendered)
        self.assertIn("Status: in progress", rendered)
        self.assertIn("## Details\nBody", rendered)
        self.assertIn("Time estimate: 1h (3,600,000 ms)", rendered)
        self.assertIn("Tracked time: 30m (1,800,000 ms)", rendered)
        self.assertIn("Tags: bug", rendered)
        self.assertIn("Outcome:\nShipped", rendered)

    def test_extract_task_checklists_preserves_ids_completion_and_item_order(self) -> None:
        details = extract_task_details(
            {
                "name": "Task",
                "checklists": [
                    {
                        "id": "check-2",
                        "name": "Release",
                        "orderindex": 2,
                        "items": [
                            {
                                "id": "item-2", "name": "Ship", "orderindex": 2,
                                "resolved": False, "parent": "item-1", "children": [],
                            },
                            {
                                "id": "item-1", "name": "Review", "orderindex": 1,
                                "resolved": True, "parent": None, "children": ["item-2"],
                            },
                        ],
                    },
                    {"id": "check-1", "name": "Prepare", "orderindex": 1, "items": []},
                ],
            },
            outcome_field_id="",
        )

        data = details_to_dict(details)
        self.assertEqual([checklist["name"] for checklist in data["checklists"]], ["Prepare", "Release"])
        self.assertEqual(data["checklists"][1], {
            "id": "check-2",
            "name": "Release",
            "items": [
                {
                    "id": "item-1", "name": "Review", "resolved": True,
                    "parent": None, "children": ["item-2"],
                },
                {
                    "id": "item-2", "name": "Ship", "resolved": False,
                    "parent": "item-1", "children": [],
                },
            ],
        })

    def test_render_task_checklists_shows_nested_completion(self) -> None:
        details = extract_task_details(
            {
                "name": "Task",
                "checklists": [{
                    "id": "check-1",
                    "name": "Release",
                    "items": [
                        {"id": "child", "name": "Ship", "resolved": False, "parent": "root"},
                        {"id": "root", "name": "Review", "resolved": True, "parent": None},
                    ],
                }],
            },
            outcome_field_id="",
        )

        self.assertIn(
            "Checklists: 1\n  Release\n    [x] Review\n      [ ] Ship",
            render_task_details(details),
        )

    def test_render_task_checklists_keeps_items_with_missing_or_cyclic_parents(self) -> None:
        details = extract_task_details(
            {"checklists": [{"name": "Review", "items": [
                {"id": "orphan", "name": "Orphan", "parent": "missing", "resolved": False},
                {"id": "cycle-a", "name": "Cycle A", "parent": "cycle-b", "resolved": False},
                {"id": "cycle-b", "name": "Cycle B", "parent": "cycle-a", "resolved": True},
            ]}]},
            outcome_field_id="",
        )

        rendered = render_task_details(details)
        self.assertEqual(rendered.count("Orphan"), 1)
        self.assertEqual(rendered.count("Cycle A"), 1)
        self.assertEqual(rendered.count("Cycle B"), 1)

    def test_task_checklists_default_to_empty_for_missing_or_malformed_payload(self) -> None:
        cases = (
            ({"name": "Task"}, []),
            ({"name": "Task", "checklists": None}, []),
            ({"name": "Task", "checklists": [None, {"name": "Empty", "items": "invalid"}]},
             [{"id": "", "name": "Empty", "items": []}]),
        )
        for payload, expected in cases:
            with self.subTest(payload=payload):
                details = extract_task_details(payload, outcome_field_id="")
                self.assertEqual(details_to_dict(details)["checklists"], expected)
                self.assertIn(f"Checklists: {len(expected)}", render_task_details(details))

    def test_comments_default_to_disabled(self) -> None:
        args = read_task_module.build_parser().parse_args([])

        self.assertFalse(args.include_comments)
        self.assertEqual(args.comment_limit, 20)

    def test_comment_limit_rejects_values_above_api_page_size(self) -> None:
        parser = read_task_module.build_parser()

        with self.assertRaises(SystemExit):
            parser.parse_args(["--comment-limit", "26"])

    def test_get_task_comments_uses_custom_task_query_and_limit(self) -> None:
        destination = TaskDestination(
            task_id="OOLE-523",
            team_id="1234567890",
            custom_task_id=True,
        )
        captured: dict[str, object] = {}

        def fake_request(url: str, api_token: str) -> dict:
            captured["url"] = url
            captured["api_token"] = api_token
            return {"comments": [{"id": str(index)} for index in range(25)]}

        with patch("clickup_tools.read_task._request_json", fake_request):
            comments = read_task_module.get_task_comments(destination, "pk_test", limit=2)

        self.assertEqual(
            captured["url"],
            "https://api.clickup.com/api/v2/task/OOLE-523/comment?custom_task_ids=true&team_id=1234567890",
        )
        self.assertEqual(captured["api_token"], "pk_test")
        self.assertEqual([comment["id"] for comment in comments], ["0", "1"])

    def test_extract_comments_prefers_plain_text_and_falls_back_to_rich_text(self) -> None:
        comments = read_task_module.extract_comments(
            [
                {
                    "id": "458",
                    "comment_text": "First comment",
                    "comment": [{"text": "Ignored rich text"}],
                    "user": {"username": "Alice"},
                    "date": "1568036964079",
                    "resolved": False,
                },
                {
                    "id": "459",
                    "comment": [{"text": "Rich "}, {"text": "comment"}],
                    "user": {"id": 42},
                    "date": "1568037964079",
                    "resolved": True,
                },
            ]
        )

        self.assertEqual(comments[0].text, "First comment")
        self.assertEqual(comments[0].user, "Alice")
        self.assertEqual(comments[0].date_ms, 1568036964079)
        self.assertEqual(comments[1].text, "Rich comment")
        self.assertEqual(comments[1].user, "User 42")
        self.assertTrue(comments[1].resolved)

    def test_requested_comments_appear_in_text_and_json(self) -> None:
        from dataclasses import replace as dc_replace

        details = extract_task_details(
            {"name": "Task", "status": "open", "custom_fields": []},
            outcome_field_id="",
        )
        details = dc_replace(
            details,
            comments=[
                read_task_module.Comment(
                    comment_id="458",
                    user="Alice",
                    date="2019-09-09 09:49 UTC",
                    date_ms=1568036964079,
                    text="First comment",
                    resolved=False,
                )
            ],
            comments_included=True,
        )

        rendered = render_task_details(details)
        data = details_to_dict(details)

        self.assertIn("Comments: 1", rendered)
        self.assertIn("Alice  First comment", rendered)
        self.assertEqual(
            data["comments"],
            [
                {
                    "id": "458",
                    "user": "Alice",
                    "date": "2019-09-09 09:49 UTC",
                    "date_ms": 1568036964079,
                    "text": "First comment",
                    "resolved": False,
                }
            ],
        )

    def test_comments_are_absent_when_not_requested(self) -> None:
        details = extract_task_details(
            {"name": "Task", "status": "open", "custom_fields": []},
            outcome_field_id="",
        )

        self.assertNotIn("Comments:", render_task_details(details))
        self.assertNotIn("comments", details_to_dict(details))
        self.assertNotIn("comments_note", details_to_dict(details))

    def test_render_task_json_is_ai_ready(self) -> None:
        from clickup_tools.read_task import TimeEntry
        from dataclasses import replace as dc_replace

        details = extract_task_details(
            {
                "name": "Task Title",
                "status": {"status": "in progress"},
                "markdown_description": "Body",
                "time_estimate": 3_600_000,
                "time_spent": 1_800_000,
                "tags": [{"name": "bug"}],
                "custom_fields": [{"name": "Outcome", "value": "Shipped"}],
            },
            outcome_field_id="",
        )
        details = dc_replace(
            details,
            time_entries=[
                TimeEntry(
                    user="Alice",
                    date="2023-11-14 22:13 UTC",
                    duration="30m (1,800,000 ms)",
                    start_ms=1700000000000,
                    tags=["review"],
                )
            ],
        )

        data = json.loads(render_task_json(details, url="https://app.clickup.com/t/9018/OOLE-1"))

        self.assertEqual(data["title"], "Task Title")
        self.assertEqual(data["status"], "in progress")
        self.assertEqual(data["tracked_time"], "30m (1,800,000 ms)")
        self.assertEqual(data["tags"], ["bug"])
        self.assertEqual(data["outcome"], "Shipped")
        self.assertEqual(data["url"], "https://app.clickup.com/t/9018/OOLE-1")
        self.assertEqual(len(data["time_entries"]), 1)
        self.assertEqual(data["time_entries"][0]["user"], "Alice")
        self.assertEqual(data["time_entries"][0]["start_ms"], 1700000000000)
        self.assertEqual(data["time_entries"][0]["tags"], ["review"])

    def test_details_to_dict_outcome_none_when_absent(self) -> None:
        details = extract_task_details(
            {"name": "T", "status": "open", "custom_fields": []},
            outcome_field_id="missing",
        )
        data = details_to_dict(details)

        self.assertIsNone(data["outcome"])
        self.assertEqual(data["time_entries"], [])
        self.assertFalse(data["has_subtasks"])
        self.assertEqual(data["subtasks"], [])

    def test_extract_subtasks(self) -> None:
        subtasks = extract_subtasks(
            {
                "subtasks": [
                    {
                        "id": "86ev1952v",
                        "custom_id": "AITAI-225",
                        "name": "Reproduce issue",
                        "status": {"status": "live review"},
                    },
                    {"id": "86ev5w1f3", "name": "Fix it", "status": {"status": "uat review"}},
                ]
            }
        )

        self.assertEqual(len(subtasks), 2)
        self.assertEqual(subtasks[0].custom_id, "AITAI-225")
        self.assertEqual(subtasks[0].name, "Reproduce issue")
        self.assertEqual(subtasks[0].status, "live review")
        self.assertEqual(subtasks[1].custom_id, "")

    def test_extract_subtasks_absent(self) -> None:
        self.assertEqual(extract_subtasks({"name": "T"}), [])

    def test_render_and_json_include_subtasks(self) -> None:
        details = extract_task_details(
            {
                "name": "Parent",
                "status": {"status": "open"},
                "description": "Body",
                "custom_fields": [],
                "subtasks": [
                    {"id": "86abc", "custom_id": "AITAI-225", "name": "Child", "status": {"status": "open"}},
                ],
            },
            outcome_field_id="",
        )

        rendered = render_task_details(details)
        self.assertIn("Subtasks: 1", rendered)
        self.assertIn("AITAI-225  Child  (open)", rendered)

        data = json.loads(render_task_json(details))
        self.assertTrue(data["has_subtasks"])
        self.assertEqual(len(data["subtasks"]), 1)
        self.assertEqual(data["subtasks"][0]["custom_id"], "AITAI-225")
        self.assertEqual(data["subtasks"][0]["task_id"], "86abc")
        self.assertEqual(data["subtasks"][0]["status"], "open")

    def test_expand_subtasks_recurses_until_leaves(self) -> None:
        # Tree: A -> (B -> D), C. expand_subtasks fetches each node's children.
        tree = {
            "A": [{"id": "B", "custom_id": "T-B", "name": "B", "status": {"status": "open"}},
                  {"id": "C", "custom_id": "T-C", "name": "C", "status": {"status": "open"}}],
            "B": [{"id": "D", "custom_id": "T-D", "name": "D", "status": {"status": "open"}}],
            "C": [],
            "D": [],
        }
        fetched: list[str] = []

        def fake_fetch(task_id: str, api_token: str) -> list:
            fetched.append(task_id)
            return tree.get(task_id, [])

        roots = extract_subtasks({"subtasks": tree["A"]})
        with patch("clickup_tools.read_task.fetch_child_subtasks", fake_fetch):
            expanded = expand_subtasks(roots, "pk_test")

        self.assertEqual(sorted(fetched), ["B", "C", "D"])
        by_id = {s.task_id: s for s in expanded}
        self.assertEqual(len(by_id["B"].subtasks), 1)
        self.assertEqual(by_id["B"].subtasks[0].task_id, "D")
        self.assertEqual(by_id["B"].subtasks[0].subtasks, [])
        self.assertEqual(by_id["C"].subtasks, [])
        self.assertEqual(count_subtasks(expanded), 3)

    def test_expand_subtasks_guards_against_cycles(self) -> None:
        # A points to B, B points back to A. Visited set must stop the loop.
        tree = {
            "A": [{"id": "B", "name": "B", "status": {"status": "open"}}],
            "B": [{"id": "A", "name": "A", "status": {"status": "open"}}],
        }

        def fake_fetch(task_id: str, api_token: str) -> list:
            return tree.get(task_id, [])

        roots = extract_subtasks({"subtasks": tree["A"]})
        with patch("clickup_tools.read_task.fetch_child_subtasks", fake_fetch):
            expanded = expand_subtasks(roots, "pk_test")

        # B -> A -> B: the third B is already visited so recursion stops (no infinite loop).
        self.assertEqual(expanded[0].task_id, "B")
        self.assertEqual(expanded[0].subtasks[0].task_id, "A")
        self.assertEqual(expanded[0].subtasks[0].subtasks[0].task_id, "B")
        self.assertEqual(expanded[0].subtasks[0].subtasks[0].subtasks, [])

    def test_render_nested_subtasks_indented(self) -> None:
        from dataclasses import replace as dc_replace

        details = extract_task_details(
            {"name": "Parent", "status": {"status": "open"}, "custom_fields": [], "subtasks": []},
            outcome_field_id="",
        )
        details = dc_replace(
            details,
            subtasks=[
                Subtask(
                    task_id="B",
                    custom_id="T-B",
                    name="B",
                    status="open",
                    subtasks=[Subtask(task_id="D", custom_id="T-D", name="D", status="open")],
                )
            ],
        )

        rendered = render_task_details(details)
        self.assertIn("Subtasks: 2", rendered)
        self.assertIn("  - T-B  B  (open)", rendered)
        self.assertIn("    - T-D  D  (open)", rendered)

        data = json.loads(render_task_json(details))
        self.assertEqual(data["subtask_count"], 2)
        self.assertEqual(data["subtasks"][0]["subtasks"][0]["custom_id"], "T-D")

    def test_run_json_outputs_parseable_json(self) -> None:
        task_payload = {
            "id": "abc123",
            "name": "JSON Task",
            "status": {"status": "open"},
            "description": "Body",
            "time_estimate": None,
            "time_spent": 1_800_000,
            "tags": [],
            "custom_fields": [],
            "checklists": [{"id": "check-1", "name": "Release", "items": [
                {"id": "item-1", "name": "Review", "resolved": True, "parent": None}
            ]}],
        }
        entries_payload = {
            "data": [
                {"user": {"username": "Alice"}, "intervals": [{"start": "1700000000000", "time": "1800000"}]}
            ]
        }

        class FakeResponse:
            def __init__(self, body: bytes) -> None:
                self._body = body

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
                return None

            def read(self) -> bytes:
                return self._body

        def fake_urlopen(request: object, timeout: int = 0) -> FakeResponse:
            if request.full_url.endswith("/time"):
                return FakeResponse(json.dumps(entries_payload).encode("utf-8"))
            return FakeResponse(json.dumps(task_payload).encode("utf-8"))

        with (
            patch("clickup_tools.read_task.get_api_token", return_value="pk_test"),
            patch("clickup_tools.read_task.get_env_value", return_value=""),
            patch("urllib.request.urlopen", fake_urlopen),
            patch("sys.stdout") as stdout,
        ):
            exit_code = run(["--task-id", "abc123", "--json"])

        self.assertEqual(exit_code, 0)
        output = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        data = json.loads(output)
        self.assertEqual(data["title"], "JSON Task")
        self.assertEqual(data["checklists"], [{
            "id": "check-1", "name": "Release", "items": [
                {"id": "item-1", "name": "Review", "resolved": True, "parent": None, "children": []}
            ],
        }])
        self.assertEqual(data["time_entries"][0]["user"], "Alice")

    def test_run_fetches_task_and_prints_details(self) -> None:
        task_payload = {
            "name": "Task Title",
            "status": {"status": "open"},
            "description": "Body",
            "time_estimate": None,
            "time_spent": 0,
            "tags": [],
            "custom_fields": [],
        }

        class FakeResponse:
            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(task_payload).encode("utf-8")

        captured = {}

        def fake_urlopen(request: object, timeout: int = 0) -> FakeResponse:
            captured.setdefault("url", request.full_url)
            captured.setdefault("timeout", timeout)
            return FakeResponse()

        with (
            patch("clickup_tools.read_task.get_api_token", return_value="pk_test"),
            patch("clickup_tools.read_task.get_env_value", return_value=""),
            patch("urllib.request.urlopen", fake_urlopen),
            patch("sys.stdout") as stdout,
        ):
            exit_code = run(["--task-id", "abc123"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            captured["url"], "https://api.clickup.com/api/v2/task/abc123?include_subtasks=true"
        )
        self.assertEqual(captured["timeout"], 15)
        output = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        self.assertIn("Title: Task Title", output)

    def test_format_epoch_ms(self) -> None:
        self.assertEqual(format_epoch_ms(None), "Unknown date")
        self.assertEqual(format_epoch_ms("1700000000000"), "2023-11-14 22:13 UTC")

    def test_extract_time_entries(self) -> None:
        entries = extract_time_entries(
            [
                {
                    "user": {"username": "Alice", "email": "alice@example.com"},
                    "intervals": [
                        {"start": "1700100000000", "time": "3600000"},
                        {
                            "start": "1700000000000",
                            "time": "1800000",
                            "tags": [{"name": "review"}, {"name": "billable"}],
                        },
                    ],
                },
                {
                    "user": {"id": "42"},
                    "intervals": [
                        {"start": 1700050000000, "time": 600000},
                    ],
                },
            ]
        )

        # Sorted chronologically across users by interval start.
        self.assertEqual(len(entries), 3)
        self.assertEqual(entries[0].user, "Alice")
        self.assertEqual(entries[0].date, "2023-11-14 22:13 UTC")
        self.assertEqual(entries[0].duration, "30m (1,800,000 ms)")
        self.assertEqual(entries[0].tags, ["review", "billable"])
        self.assertEqual(entries[1].user, "User 42")
        self.assertEqual(entries[1].tags, [])
        self.assertEqual(entries[2].user, "Alice")
        self.assertEqual(entries[2].duration, "1h (3,600,000 ms)")

    def test_render_includes_time_entries(self) -> None:
        details = extract_task_details(
            {
                "name": "Task",
                "status": {"status": "open"},
                "description": "Body",
                "time_spent": 1_800_000,
                "tags": [],
                "custom_fields": [],
            },
            outcome_field_id="",
        )
        from dataclasses import replace
        from clickup_tools.read_task import TimeEntry

        details = replace(
            details,
            time_entries=[
                TimeEntry(
                    user="Alice",
                    date="2023-11-14 22:13 UTC",
                    duration="30m (1,800,000 ms)",
                    tags=["review", "billable"],
                )
            ],
        )
        rendered = render_task_details(details)

        self.assertIn("Time entries:", rendered)
        self.assertIn("2023-11-14 22:13 UTC  Alice  30m (1,800,000 ms)  [review, billable]", rendered)

    def test_run_fetches_time_entries(self) -> None:
        task_payload = {
            "id": "abc123",
            "team_id": "1234567890",
            "name": "Task Title",
            "status": {"status": "open"},
            "description": "Body",
            "time_estimate": None,
            "time_spent": 1_800_000,
            "tags": [],
            "custom_fields": [],
        }
        entries_payload = {
            "data": [
                {
                    "user": {"username": "Alice"},
                    "intervals": [
                        {"start": "1700000000000", "time": "1800000"},
                    ],
                }
            ]
        }

        urls: list[str] = []

        class FakeResponse:
            def __init__(self, body: bytes) -> None:
                self._body = body

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
                return None

            def read(self) -> bytes:
                return self._body

        def fake_urlopen(request: object, timeout: int = 0) -> FakeResponse:
            urls.append(request.full_url)
            if request.full_url.endswith("/time"):
                return FakeResponse(json.dumps(entries_payload).encode("utf-8"))
            return FakeResponse(json.dumps(task_payload).encode("utf-8"))

        with (
            patch("clickup_tools.read_task.get_api_token", return_value="pk_test"),
            patch("clickup_tools.read_task.get_env_value", return_value=""),
            patch("urllib.request.urlopen", fake_urlopen),
            patch("sys.stdout") as stdout,
        ):
            exit_code = run(["--task-id", "abc123"])

        self.assertEqual(exit_code, 0)
        self.assertTrue(any(url.endswith("/task/abc123/time") for url in urls))
        output = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        self.assertIn("Alice", output)

    def test_mcp_read_clickup_task_passes_args_to_runner(self) -> None:
        with patch("clickup_tools.mcp_server.run_read_task", return_value=0) as runner:
            result = read_clickup_task("OOLE-523", "1234567890")

        runner.assert_called_once_with(["--json", "--task-id", "OOLE-523", "--team-id", "1234567890"])
        self.assertEqual(result, "Success.\n")

    def test_mcp_read_clickup_task_returns_checklist_items(self) -> None:
        task = {"name": "Task", "checklists": [{"id": "c1", "name": "Launch", "items": [
            {"id": "i1", "name": "Review", "resolved": True, "parent": None}
        ]}]}
        with (
            patch("clickup_tools.read_task.get_api_token", return_value="pk_test"),
            patch("clickup_tools.read_task.get_env_value", return_value=""),
            patch("clickup_tools.read_task.get_task_with_subtasks", return_value=task),
            patch("clickup_tools.read_task.get_time_entries", return_value=[]),
        ):
            result = read_clickup_task("abc123")

        self.assertTrue(result.startswith("Success.\n"))
        data = json.loads(result.removeprefix("Success.\n"))
        self.assertEqual(data["checklists"][0]["items"][0]["name"], "Review")
        self.assertTrue(data["checklists"][0]["items"][0]["resolved"])

    def test_mcp_read_clickup_task_passes_comment_options_to_runner(self) -> None:
        with patch("clickup_tools.mcp_server.run_read_task", return_value=0) as runner:
            result = read_clickup_task("OOLE-523", "1234567890", include_comments=True, comment_limit=5)

        runner.assert_called_once_with(
            [
                "--json",
                "--task-id",
                "OOLE-523",
                "--team-id",
                "1234567890",
                "--include-comments",
                "--comment-limit",
                "5",
            ]
        )
        self.assertEqual(result, "Success.\n")

    def test_run_fetches_comments_only_when_requested(self) -> None:
        task_payload = {
            "id": "abc123",
            "name": "Commented Task",
            "status": {"status": "open"},
            "description": "Body",
            "tags": [],
            "custom_fields": [],
        }
        comments_payload = {
            "comments": [
                {
                    "id": "458",
                    "comment_text": "First comment",
                    "user": {"username": "Alice"},
                    "date": "1568036964079",
                    "resolved": False,
                },
                {
                    "id": "459",
                    "comment_text": "Second comment",
                    "user": {"username": "Bob"},
                    "date": "1568037964079",
                    "resolved": True,
                },
            ]
        }
        urls: list[str] = []

        class FakeResponse:
            def __init__(self, body: dict) -> None:
                self._body = body

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self._body).encode("utf-8")

        def fake_urlopen(request: object, timeout: int = 0) -> FakeResponse:
            urls.append(request.full_url)
            if "/comment" in request.full_url:
                return FakeResponse(comments_payload)
            if request.full_url.endswith("/time"):
                return FakeResponse({"data": []})
            return FakeResponse(task_payload)

        with (
            patch("clickup_tools.read_task.get_api_token", return_value="pk_test"),
            patch("clickup_tools.read_task.get_env_value", return_value=""),
            patch("urllib.request.urlopen", fake_urlopen),
            patch("sys.stdout") as stdout,
        ):
            exit_code = run(
                ["--task-id", "abc123", "--json", "--include-comments", "--comment-limit", "1"]
            )

        self.assertEqual(exit_code, 0)
        self.assertTrue(any(url.endswith("/task/abc123/comment") for url in urls))
        output = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        data = json.loads(output)
        self.assertEqual(len(data["comments"]), 1)
        self.assertEqual(data["comments"][0]["text"], "First comment")

    def test_run_skips_comment_request_by_default(self) -> None:
        task_payload = {
            "id": "abc123",
            "name": "Task",
            "status": {"status": "open"},
            "description": "Body",
            "tags": [],
            "custom_fields": [],
        }
        urls: list[str] = []

        class FakeResponse:
            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
                return None

            def read(self) -> bytes:
                payload = {"data": []} if urls[-1].endswith("/time") else task_payload
                return json.dumps(payload).encode("utf-8")

        def fake_urlopen(request: object, timeout: int = 0) -> FakeResponse:
            urls.append(request.full_url)
            return FakeResponse()

        with (
            patch("clickup_tools.read_task.get_api_token", return_value="pk_test"),
            patch("clickup_tools.read_task.get_env_value", return_value=""),
            patch("urllib.request.urlopen", fake_urlopen),
            patch("sys.stdout"),
        ):
            exit_code = run(["--task-id", "abc123", "--json"])

        self.assertEqual(exit_code, 0)
        self.assertFalse(any("/comment" in url for url in urls))

    def test_comment_fetch_failure_keeps_task_read_successful(self) -> None:
        import urllib.error

        task_payload = {
            "id": "abc123",
            "name": "Task",
            "status": {"status": "open"},
            "description": "Body",
            "tags": [],
            "custom_fields": [],
        }

        class FakeResponse:
            def __init__(self, body: dict) -> None:
                self._body = body

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(self._body).encode("utf-8")

        def fake_urlopen(request: object, timeout: int = 0) -> FakeResponse:
            if "/comment" in request.full_url:
                raise urllib.error.URLError("offline")
            if request.full_url.endswith("/time"):
                return FakeResponse({"data": []})
            return FakeResponse(task_payload)

        with (
            patch("clickup_tools.read_task.get_api_token", return_value="pk_test"),
            patch("clickup_tools.read_task.get_env_value", return_value=""),
            patch("urllib.request.urlopen", fake_urlopen),
            patch("sys.stdout") as stdout,
        ):
            exit_code = run(["--task-id", "abc123", "--json", "--include-comments"])

        self.assertEqual(exit_code, 0)
        output = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        data = json.loads(output)
        self.assertEqual(data["comments"], [])
        self.assertEqual(data["comments_note"], "Unavailable (network error: offline)")

    def test_run_reads_task_id_from_env_when_not_provided(self) -> None:
        task_payload = {
            "name": "Env Task",
            "status": {"status": "open"},
            "description": "Body",
            "time_estimate": None,
            "time_spent": 0,
            "tags": [],
            "custom_fields": [],
        }

        class FakeResponse:
            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(task_payload).encode("utf-8")

        captured = {}

        def fake_urlopen(request: object, timeout: int = 0) -> FakeResponse:
            captured.setdefault("url", request.full_url)
            return FakeResponse()

        def fake_env(name: str) -> str:
            return "abc123" if name == "CLICKUP_TASK_ID" else ""

        with (
            patch("clickup_tools.read_task.get_api_token", return_value="pk_test"),
            patch("clickup_tools.read_task.get_env_value", side_effect=fake_env),
            patch("urllib.request.urlopen", fake_urlopen),
            patch("sys.stdout"),
        ):
            exit_code = run([])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            captured["url"], "https://api.clickup.com/api/v2/task/abc123?include_subtasks=true"
        )


if __name__ == "__main__":
    unittest.main()
