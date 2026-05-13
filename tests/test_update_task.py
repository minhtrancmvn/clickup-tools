from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from clickup_tools.update_task import (  # noqa: E402
    TaskDestination,
    build_multipart_body,
    build_task_url,
    extract_attachment_url,
    find_local_attachment_references,
    is_custom_task_id,
    parse_task_id,
    prepare_markdown_task_content,
    resolve_destination,
    rewrite_local_attachment_references,
    update_task_description,
)


class FakeResponse:
    def __init__(self, body: bytes = b"{}") -> None:
        self.body = body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class ClickUpUpdateTaskTests(unittest.TestCase):
    def test_parse_task_id_from_url(self) -> None:
        self.assertEqual(
            parse_task_id("https://app.clickup.com/t/1234567890/OOLE-523"),
            "OOLE-523",
        )
        self.assertEqual(parse_task_id("abc123"), "abc123")

    def test_is_custom_task_id(self) -> None:
        self.assertTrue(is_custom_task_id("OOLE-523"))
        self.assertFalse(is_custom_task_id("abc123"))

    def test_build_task_url(self) -> None:
        self.assertEqual(
            build_task_url("OOLE-523", "1234567890"),
            "https://app.clickup.com/t/1234567890/OOLE-523",
        )

    def test_resolve_destination_from_metadata_and_env_team_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            markdown = Path(tmp) / "task.md"
            markdown.write_text("---\nclickup-task-id: OOLE-523\n---\n# Body\n", encoding="utf-8")

            with patch("clickup_tools.update_task.get_env_value", return_value="1234567890"):
                destination = resolve_destination(str(markdown))

        self.assertEqual(
            destination,
            TaskDestination(
                task_id="OOLE-523",
                team_id="1234567890",
                custom_task_id=True,
            ),
        )

    def test_resolve_destination_prefers_cli_over_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            markdown = Path(tmp) / "task.md"
            markdown.write_text(
                "---\nclickup-task-id: OOLE-523\nclickup-team-id: 1\n---\n# Body\n",
                encoding="utf-8",
            )

            destination = resolve_destination(
                str(markdown),
                task_id="abc123",
                team_id="2",
            )

        self.assertEqual(
            destination,
            TaskDestination(task_id="abc123", team_id="2", custom_task_id=False),
        )

    def test_find_local_attachment_references(self) -> None:
        fixture_dir = ROOT / "tests" / "fixtures"
        refs = find_local_attachment_references(
            "![flow](flow.gif)\n"
            "[same](flow.gif)\n"
            "[remote](https://example.com/file.pdf)\n"
            "[anchor](#heading)\n",
            fixture_dir,
        )

        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0].target, "flow.gif")
        self.assertEqual(refs[0].path, fixture_dir / "flow.gif")

    def test_rewrite_local_attachment_references(self) -> None:
        fixture_dir = ROOT / "tests" / "fixtures"
        flow_path = (fixture_dir / "flow.gif").resolve()
        content = "![flow](flow.gif)\n[file](<flow.gif>)\n"

        rewritten = rewrite_local_attachment_references(
            content,
            fixture_dir,
            {flow_path: "https://attachments.example/flow.gif"},
        )

        self.assertEqual(
            rewritten,
            "![flow](<https://attachments.example/flow.gif>)\n"
            "[file](<https://attachments.example/flow.gif>)\n",
        )

    def test_prepare_markdown_uploads_each_unique_file_once_and_rewrites(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            asset = base / "flow.gif"
            asset.write_bytes(b"gif")
            markdown = base / "task.md"
            markdown.write_text(
                "---\nclickup-task-id: abc123\n---\n"
                "![flow](flow.gif)\n"
                "[download](flow.gif)\n",
                encoding="utf-8",
            )

            with patch(
                "clickup_tools.update_task.upload_task_attachment",
                return_value="https://attachments.example/flow.gif",
            ) as upload:
                prepared = prepare_markdown_task_content(
                    markdown,
                    "pk_test",
                    TaskDestination(task_id="abc123"),
                    rich_links=False,
                )

        self.assertEqual(upload.call_count, 1)
        self.assertIn("![flow](<https://attachments.example/flow.gif>)", prepared.content)
        self.assertIn("[download](<https://attachments.example/flow.gif>)", prepared.content)

    def test_prepare_markdown_aborts_on_missing_attachment(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            markdown = Path(tmp) / "task.md"
            markdown.write_text(
                "---\nclickup-task-id: abc123\n---\n![missing](missing.png)\n",
                encoding="utf-8",
            )

            with self.assertRaises(FileNotFoundError):
                prepare_markdown_task_content(
                    markdown,
                    "pk_test",
                    TaskDestination(task_id="abc123"),
                    rich_links=False,
                )

    def test_update_task_description_uses_markdown_content_and_custom_query(self) -> None:
        captured = {}

        def fake_urlopen(request: object) -> FakeResponse:
            captured["url"] = request.full_url
            captured["data"] = request.data
            return FakeResponse(b"{}")

        destination = TaskDestination(
            task_id="OOLE-523",
            team_id="1234567890",
            custom_task_id=True,
        )

        with patch("urllib.request.urlopen", fake_urlopen):
            update_task_description(destination, "# Body", "pk_test")

        self.assertEqual(
            captured["url"],
            "https://api.clickup.com/api/v2/task/OOLE-523?custom_task_ids=true&team_id=1234567890",
        )
        self.assertEqual(
            json.loads(captured["data"].decode("utf-8")),
            {"markdown_content": "# Body"},
        )

    def test_build_multipart_body_uses_attachment_field(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            asset = Path(tmp) / "flow.gif"
            asset.write_bytes(b"gif")
            body = build_multipart_body(asset, "boundary")

        self.assertIn(b'name="attachment"; filename="flow.gif"', body)
        self.assertIn(b"Content-Type: image/gif", body)

    def test_extract_attachment_url(self) -> None:
        self.assertEqual(
            extract_attachment_url({"attachment": {"url": "https://example.com/file.png"}}),
            "https://example.com/file.png",
        )


if __name__ == "__main__":
    unittest.main()
