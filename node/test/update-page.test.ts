import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BufferedOutput, pyResolve } from "../src/common.js";
import { getEnvFileCandidates, getEnvValue, readApiTokenFromEnvFile } from "../src/env.js";
import {
  buildPageUrl,
  createLinkContext,
  extractTitle,
  findLocalMediaReferences,
  getEditMode,
  linkifyBareUrls,
  parseFrontMatter,
  parsePageUrl,
  readClickupPageFromMetadata,
  resolveArgs,
  run,
} from "../src/update-page.js";
import { FIXTURES, bodyJson, jsonResponse, stubFetch, tempDir } from "./helpers.js";

describe("ClickUpUpdatePageTests", () => {
  it("parse_v_dc_url", () => {
    expect(parsePageUrl("https://app.clickup.com/123/v/dc/doc-1/page-2")).toEqual(["123", "doc-1", "page-2"]);
  });

  it("parse_docs_url", () => {
    expect(parsePageUrl("https://app.clickup.com/123/docs/doc-1/page-2?view=abc")).toEqual(["123", "doc-1", "page-2"]);
  });

  it("parse_invalid_url", () => {
    expect(() => parsePageUrl("https://example.com/nope")).toThrow(/Cannot parse ClickUp page URL: 'https:\/\/example.com\/nope'/);
  });

  it("build_page_url", () => {
    expect(buildPageUrl("123", "doc-1", "page-2")).toBe("https://app.clickup.com/123/v/dc/doc-1/page-2");
  });

  it("resolve_args_with_url", () => {
    expect(resolveArgs({ urlOrFile: "https://app.clickup.com/123/v/dc/doc-1/page-2", file: "notes.md" })).toEqual([
      "123",
      "doc-1",
      "page-2",
      "notes.md",
    ]);
  });

  it("resolve_args_with_explicit_ids", () => {
    expect(resolveArgs({ workspaceId: "123", docId: "doc-1", pageId: "page-2", urlOrFile: "notes.md" })).toEqual([
      "123",
      "doc-1",
      "page-2",
      "notes.md",
    ]);
  });

  it("resolve_args_with_markdown_metadata", () => {
    const fixture = path.join(FIXTURES, "with-clickup-page.md");
    expect(resolveArgs({ urlOrFile: fixture })).toEqual(["123", "doc-1", "page-2", fixture]);
  });

  it("parse_front_matter", () => {
    const [metadata, body] = parseFrontMatter(
      "---\n" + "clickup-page: https://app.clickup.com/123/v/dc/doc-1/page-2\n" + "title: 'Example'\n" + "---\n" + "# Body\n",
    );
    expect(metadata["clickup-page"]).toBe("https://app.clickup.com/123/v/dc/doc-1/page-2");
    expect(metadata.title).toBe("Example");
    expect(body).toBe("# Body\n");
  });

  it("read_clickup_page_from_metadata", () => {
    expect(readClickupPageFromMetadata(path.join(FIXTURES, "with-clickup-page.md"))).toEqual(["123", "doc-1", "page-2"]);
  });

  it("read_api_token_from_env_file", () => {
    expect(readApiTokenFromEnvFile(path.join(FIXTURES, "example.env"))).toBe("pk_test_token");
  });

  it("explicit_env_file_is_checked_before_default_env_files", () => {
    const explicitEnv = path.join(tempDir(), "clickup.env");
    fs.writeFileSync(explicitEnv, "CLICKUP_API_TOKEN=pk_explicit\n");
    vi.stubEnv("CLICKUP_TOOLS_ENV_FILE", explicitEnv);

    expect(pyResolve(getEnvFileCandidates()[0]!)).toBe(pyResolve(explicitEnv));
  });

  it("get_env_value_reads_api_token_from_explicit_env_file", () => {
    const explicitEnv = path.join(tempDir(), "clickup.env");
    fs.writeFileSync(explicitEnv, "CLICKUP_API_TOKEN=pk_explicit\nCLICKUP_TEAM_ID=1234567890\n");
    vi.stubEnv("CLICKUP_TOOLS_ENV_FILE", explicitEnv);

    expect(getEnvValue("CLICKUP_API_TOKEN")).toBe("pk_explicit");
    expect(getEnvValue("CLICKUP_TEAM_ID")).toBe("1234567890");
  });

  it("find_local_media_references", () => {
    expect(findLocalMediaReferences("![flow](flow.gif)\n", FIXTURES)).toEqual([path.join(FIXTURES, "flow.gif")]);
  });

  it("find_local_media_references_with_angle_bracket_path", () => {
    expect(findLocalMediaReferences("![flow](<flow.gif>)\n", FIXTURES)).toEqual([path.join(FIXTURES, "flow.gif")]);
  });

  it("find_local_media_references_ignores_remote_images", () => {
    expect(findLocalMediaReferences("![flow](https://example.com/flow.gif)\n", FIXTURES)).toEqual([]);
  });

  it("linkify_clickup_urls_with_page_name", async () => {
    const url = "https://app.clickup.com/123/v/dc/doc-1/page-2";
    const calls = stubFetch(() => jsonResponse({ name: "Calculation Method" }));

    const [content, count] = await linkifyBareUrls(`Refer to ${url} for details.`, createLinkContext("pk_test"));

    expect(content).toBe(`Refer to [Calculation Method](<${url}>) for details.`);
    expect(count).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://api.clickup.com/api/v3/workspaces/123/docs/doc-1/pages/page-2?content_format=text%2Fplain",
    );
    expect(calls[0]!.headers.Authorization).toBe("pk_test");
  });

  it("linkify_figma_url_as_preview_when_oembed_has_thumbnail", async () => {
    const url = "https://www.figma.com/proto/file/example";
    const calls = stubFetch(() =>
      jsonResponse({ title: "Complete Job Flow", thumbnail_url: "https://cdn.example/preview.png" }),
    );

    const [content, count] = await linkifyBareUrls(`${url}\n`, createLinkContext("pk_test"));

    expect(content).toContain(`[![Figma preview: Complete Job Flow](<https://cdn.example/preview.png>)](<${url}>)`);
    expect(content).toContain(`[Complete Job Flow](<${url}>)`);
    expect(count).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://api.figma.com/v1/oembed?url=https%3A%2F%2Fwww.figma.com%2Fproto%2Ffile%2Fexample&maxwidth=960&maxheight=540",
    );
  });

  it("linkify_figma_url_falls_back_to_markdown_link", async () => {
    const url = "https://www.figma.com/design/file/example";
    stubFetch(() => jsonResponse({}));

    const [content, count] = await linkifyBareUrls(`Design: ${url}`, createLinkContext("pk_test"));

    expect(content).toBe(`Design: [Figma design](<${url}>)`);
    expect(count).toBe(1);
  });

  it("edit_modes", () => {
    expect(getEditMode({ append: false, prepend: false })).toBe("replace");
    expect(getEditMode({ append: true, prepend: false })).toBe("append");
    expect(getEditMode({ append: false, prepend: true })).toBe("prepend");
  });
});

describe("TypeScript port behaviour", () => {
  it("linkify_skips_fenced_code_inline_code_and_existing_links", async () => {
    const url = "https://app.clickup.com/123/v/dc/doc-1/page-2";
    const calls = stubFetch(() => jsonResponse({ name: "Page" }));
    const source = ["```", url, "```", `\`${url}\``, `[x](${url})`, `<${url}>`, ""].join("\n");

    const [content, count] = await linkifyBareUrls(source, createLinkContext("pk_test"));

    expect(content).toBe(source);
    expect(count).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("linkify_keeps_trailing_punctuation_and_caches_lookups", async () => {
    const url = "https://app.clickup.com/123/v/dc/doc-1/page-2";
    const calls = stubFetch(() => jsonResponse({ page: { name: "Nested [Name]" } }));

    const [content, count] = await linkifyBareUrls(`See ${url}. And (${url}).`, createLinkContext("pk_test"));

    expect(content).toBe(`See [Nested \\[Name\\]](<${url}>). And ([Nested \\[Name\\]](<${url}>)).`);
    expect(count).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("extract_title_drops_h1_and_following_blank_line", () => {
    expect(extractTitle("# Title\n\nBody\n")).toEqual(["Title", "Body\n"]);
    expect(extractTitle("No heading\n")).toEqual([null, "No heading\n"]);
  });

  it("parse_front_matter_handles_crlf_files", () => {
    const [metadata, body] = parseFrontMatter("---\r\nclickup-page: x\r\n---\r\nBody\r\n");
    expect(metadata["clickup-page"]).toBe("x");
    expect(body).toBe("Body\r\n");
  });

  it("run_updates_page_with_title_and_markdown_body", async () => {
    const dir = tempDir();
    const markdown = path.join(dir, "notes.md");
    fs.writeFileSync(
      markdown,
      "---\r\nclickup-page: https://app.clickup.com/123/v/dc/doc-1/page-2\r\n---\r\n# Page Title\r\n\r\nBody text\r\n",
    );
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch(() => new Response("", { status: 200 }));
    const io = new BufferedOutput();

    const code = await run([markdown, "--no-open", "--prepend"], io);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://api.clickup.com/api/v3/workspaces/123/docs/doc-1/pages/page-2");
    expect(bodyJson(calls[0]!)).toEqual({
      content: "Body text\n",
      content_format: "text/md",
      content_edit_mode: "prepend",
      name: "Page Title",
    });
    expect(io.out).toContain("Page updated (prepend)");
    expect(io.out).not.toContain("Opening in browser");
  });

  it("run_reports_api_error_detail", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    stubFetch(() => new Response(JSON.stringify({ err: "Page not found", ECODE: "DOC_404" }), { status: 404 }));
    const io = new BufferedOutput();

    const code = await run([path.join(FIXTURES, "with-clickup-page.md"), "--no-open"], io);

    expect(code).toBe(1);
    expect(io.err).toContain("API error 404 Not Found");
    expect(io.err).toContain("  Page not found");
  });

  it("run_refuses_local_media_without_flag", async () => {
    const dir = tempDir();
    fs.copyFileSync(path.join(FIXTURES, "flow.gif"), path.join(dir, "flow.gif"));
    const markdown = path.join(dir, "notes.md");
    fs.writeFileSync(markdown, "---\nclickup-page: https://app.clickup.com/1/v/dc/d/p\n---\n![flow](flow.gif)\n");
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const io = new BufferedOutput();

    expect(await run([markdown, "--no-open"], io)).toBe(1);
    expect(io.err).toContain("Local media references cannot be rendered");
  });

  it("run_requires_api_token", async () => {
    const io = new BufferedOutput();
    expect(await run([path.join(FIXTURES, "with-clickup-page.md")], io)).toBe(1);
    expect(io.err).toContain("CLICKUP_API_TOKEN is not set.");
  });

  it("run_rejects_append_with_prepend_like_argparse", async () => {
    const io = new BufferedOutput();
    expect(await run(["notes.md", "--append", "--prepend"], io)).toBe(2);
    expect(io.err).toContain("clickup-update-page: error: argument --prepend: not allowed with argument --append");
  });

  it("run_without_arguments_prints_help", async () => {
    const io = new BufferedOutput();
    expect(await run([], io)).toBe(0);
    expect(io.out).toMatch(/^usage: clickup-update-page/);
  });
});
