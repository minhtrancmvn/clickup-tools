from __future__ import annotations

import argparse
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from clickup_tools.update_page import (  # noqa: E402
    LinkContext,
    build_page_url,
    find_local_media_references,
    get_edit_mode,
    linkify_bare_urls,
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

    def test_find_local_media_references(self) -> None:
        fixture_dir = ROOT / "tests" / "fixtures"
        refs = find_local_media_references("![flow](flow.gif)\n", fixture_dir)
        self.assertEqual(refs, [str(fixture_dir / "flow.gif")])

    def test_find_local_media_references_with_angle_bracket_path(self) -> None:
        fixture_dir = ROOT / "tests" / "fixtures"
        refs = find_local_media_references("![flow](<flow.gif>)\n", fixture_dir)
        self.assertEqual(refs, [str(fixture_dir / "flow.gif")])

    def test_find_local_media_references_ignores_remote_images(self) -> None:
        fixture_dir = ROOT / "tests" / "fixtures"
        refs = find_local_media_references(
            "![flow](https://example.com/flow.gif)\n",
            fixture_dir,
        )
        self.assertEqual(refs, [])

    def test_linkify_clickup_urls_with_page_name(self) -> None:
        url = "https://app.clickup.com/123/v/dc/doc-1/page-2"
        with patch(
            "clickup_tools.update_page.get_page",
            return_value={"name": "Calculation Method"},
        ):
            content, count = linkify_bare_urls(
                f"Refer to {url} for details.",
                LinkContext(api_token="pk_test"),
            )

        self.assertEqual(content, f"Refer to [Calculation Method](<{url}>) for details.")
        self.assertEqual(count, 1)

    def test_linkify_figma_url_as_preview_when_oembed_has_thumbnail(self) -> None:
        url = "https://www.figma.com/proto/file/example"
        with patch(
            "clickup_tools.update_page.get_figma_oembed",
            return_value={
                "title": "Complete Job Flow",
                "thumbnail_url": "https://cdn.example/preview.png",
            },
        ):
            content, count = linkify_bare_urls(
                f"{url}\n",
                LinkContext(api_token="pk_test"),
            )

        self.assertIn(
            f"[![Figma preview: Complete Job Flow](<https://cdn.example/preview.png>)](<{url}>)",
            content,
        )
        self.assertIn(f"[Complete Job Flow](<{url}>)", content)
        self.assertEqual(count, 1)

    def test_linkify_figma_url_falls_back_to_markdown_link(self) -> None:
        url = "https://www.figma.com/design/file/example"
        with patch("clickup_tools.update_page.get_figma_oembed", return_value={}):
            content, count = linkify_bare_urls(
                f"Design: {url}",
                LinkContext(api_token="pk_test"),
            )

        self.assertEqual(content, f"Design: [Figma design](<{url}>)")
        self.assertEqual(count, 1)

    def test_edit_modes(self) -> None:
        self.assertEqual(get_edit_mode(argparse.Namespace(append=False, prepend=False)), "replace")
        self.assertEqual(get_edit_mode(argparse.Namespace(append=True, prepend=False)), "append")
        self.assertEqual(get_edit_mode(argparse.Namespace(append=False, prepend=True)), "prepend")


if __name__ == "__main__":
    unittest.main()
