from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from clickup_tools.read_task import (  # noqa: E402
    extract_outcome_value,
    extract_tags,
    extract_task_details,
    format_duration_ms,
    parse_task_identifier,
    render_task_details,
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
            captured["url"] = request.full_url
            captured["timeout"] = timeout
            return FakeResponse()

        with (
            patch("clickup_tools.read_task.get_api_token", return_value="pk_test"),
            patch("clickup_tools.read_task.get_env_value", return_value=""),
            patch("urllib.request.urlopen", fake_urlopen),
            patch("sys.stdout") as stdout,
        ):
            exit_code = run(["--task-id", "abc123"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured["url"], "https://api.clickup.com/api/v2/task/abc123")
        self.assertEqual(captured["timeout"], 15)
        output = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        self.assertIn("Title: Task Title", output)

    def test_mcp_read_clickup_task_passes_args_to_runner(self) -> None:
        with patch("clickup_tools.mcp_server.run_read_task", return_value=0) as runner:
            result = read_clickup_task("OOLE-523", "1234567890")

        runner.assert_called_once_with(["--task-id", "OOLE-523", "--team-id", "1234567890"])
        self.assertEqual(result, "Success.\n")

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
            captured["url"] = request.full_url
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
        self.assertEqual(captured["url"], "https://api.clickup.com/api/v2/task/abc123")


if __name__ == "__main__":
    unittest.main()
