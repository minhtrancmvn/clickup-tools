from __future__ import annotations

import argparse
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from clickup_tools.update_page import (  # noqa: E402
    build_page_url,
    get_edit_mode,
    parse_front_matter,
    parse_page_url,
    read_api_token_from_env_file,
    read_clickup_page_from_metadata,
    resolve_args,
)


class ClickUpUpdatePageTests(unittest.TestCase):
    def test_parse_v_dc_url(self) -> None:
        self.assertEqual(
            parse_page_url("https://app.clickup.com/123/v/dc/doc-1/page-2"),
            ("123", "doc-1", "page-2"),
        )

    def test_parse_docs_url(self) -> None:
        self.assertEqual(
            parse_page_url("https://app.clickup.com/123/docs/doc-1/page-2?view=abc"),
            ("123", "doc-1", "page-2"),
        )

    def test_parse_invalid_url(self) -> None:
        with self.assertRaises(ValueError):
            parse_page_url("https://example.com/nope")

    def test_build_page_url(self) -> None:
        self.assertEqual(
            build_page_url("123", "doc-1", "page-2"),
            "https://app.clickup.com/123/v/dc/doc-1/page-2",
        )

    def test_resolve_args_with_url(self) -> None:
        args = argparse.Namespace(
            workspace_id=None,
            doc_id=None,
            page_id=None,
            url_or_file="https://app.clickup.com/123/v/dc/doc-1/page-2",
            file="notes.md",
        )
        self.assertEqual(resolve_args(args), ("123", "doc-1", "page-2", "notes.md"))

    def test_resolve_args_with_explicit_ids(self) -> None:
        args = argparse.Namespace(
            workspace_id="123",
            doc_id="doc-1",
            page_id="page-2",
            url_or_file="notes.md",
            file=None,
        )
        self.assertEqual(resolve_args(args), ("123", "doc-1", "page-2", "notes.md"))

    def test_resolve_args_with_markdown_metadata(self) -> None:
        fixture = ROOT / "tests" / "fixtures" / "with-clickup-page.md"
        args = argparse.Namespace(
            workspace_id=None,
            doc_id=None,
            page_id=None,
            url_or_file=str(fixture),
            file=None,
        )
        self.assertEqual(
            resolve_args(args),
            ("123", "doc-1", "page-2", str(fixture)),
        )

    def test_parse_front_matter(self) -> None:
        metadata, body = parse_front_matter(
            "---\n"
            "clickup-page: https://app.clickup.com/123/v/dc/doc-1/page-2\n"
            "title: 'Example'\n"
            "---\n"
            "# Body\n"
        )
        self.assertEqual(
            metadata["clickup-page"],
            "https://app.clickup.com/123/v/dc/doc-1/page-2",
        )
        self.assertEqual(metadata["title"], "Example")
        self.assertEqual(body, "# Body\n")

    def test_read_clickup_page_from_metadata(self) -> None:
        fixture = ROOT / "tests" / "fixtures" / "with-clickup-page.md"
        self.assertEqual(
            read_clickup_page_from_metadata(str(fixture)),
            ("123", "doc-1", "page-2"),
        )

    def test_read_api_token_from_env_file(self) -> None:
        fixture = ROOT / "tests" / "fixtures" / "example.env"
        self.assertEqual(read_api_token_from_env_file(fixture), "pk_test_token")

    def test_edit_modes(self) -> None:
        self.assertEqual(get_edit_mode(argparse.Namespace(append=False, prepend=False)), "replace")
        self.assertEqual(get_edit_mode(argparse.Namespace(append=True, prepend=False)), "append")
        self.assertEqual(get_edit_mode(argparse.Namespace(append=False, prepend=True)), "prepend")


if __name__ == "__main__":
    unittest.main()
