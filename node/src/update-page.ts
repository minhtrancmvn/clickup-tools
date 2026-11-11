/** Update a ClickUp Doc page from a Markdown file. */

import fs from "node:fs";
import path from "node:path";

import {
  BOLD,
  RESET,
  FileNotFoundError,
  HttpError,
  NetworkError,
  ValueError,
  err,
  errorMessage,
  formatThousands,
  httpRequest,
  info,
  isDict,
  isFile,
  normalizeNewlines,
  ok,
  openBrowser,
  parseCli,
  parseJson,
  pathExists,
  print,
  printMissingTokenHelp,
  processOutput,
  pyLen,
  pyRepr,
  pyResolve,
  pySplitlines,
  pyUnquote,
  pyUrlencode,
  reportHttpError,
  expandUser,
  flagOption,
  stringOption,
  urlScheme,
  type CliSpec,
  type Output,
  type ParsedCli,
} from "./common.js";
import { cleanMetadataValue, getApiToken } from "./env.js";

const URL_PATTERNS = [
  /app\.clickup\.com\/([^/]+)\/v\/dc\/([^/?#]+)\/([^/?#]+)/,
  /app\.clickup\.com\/([^/]+)\/docs\/([^/?#]+)\/([^/?#]+)/,
];
const MARKDOWN_IMAGE_SOURCE = String.raw`!\[([^\]]*)\]\((<[^>\n]+>|[^)\s\n]+)([^)\n]*)\)`;
const URL_SOURCE = String.raw`https?://[^\s<>\]]+`;
const TRAILING_URL_PUNCTUATION = ".,;:";

export type EditMode = "replace" | "append" | "prepend";

/** Markdown content after ClickUp-oriented preprocessing. */
export interface PreparedContent {
  content: string;
  localMediaRefs: string[];
  normalizedLinks: number;
  /** Page subtitle from the `subtitle` front matter field. */
  subtitle: string | null;
}

/** Caches metadata lookups while linkifying one document. */
export interface LinkContext {
  apiToken: string;
  clickupTitles: Map<string, string>;
  figmaOembed: Map<string, Record<string, unknown>>;
}

export function createLinkContext(apiToken: string): LinkContext {
  return { apiToken, clickupTitles: new Map(), figmaOembed: new Map() };
}

/** Return [workspaceId, docId, pageId] parsed from a ClickUp page URL. */
export function parsePageUrl(url: string): [string, string, string] {
  for (const pattern of URL_PATTERNS) {
    const match = pattern.exec(url);
    if (match) {
      return [match[1]!, match[2]!, match[3]!];
    }
  }
  throw new ValueError(
    `Cannot parse ClickUp page URL: ${pyRepr(url)}\n` +
      "Expected: https://app.clickup.com/<workspace_id>/v/dc/<doc_id>/<page_id>",
  );
}

/** Build a canonical ClickUp Doc page URL. */
export function buildPageUrl(workspaceId: string, docId: string, pageId: string): string {
  return `https://app.clickup.com/${workspaceId}/v/dc/${docId}/${pageId}`;
}

/**
 * Return [title, body] where the leading H1 line is stripped from body.
 * If no H1 is found, returns [null, content] unchanged.
 */
export function extractTitle(content: string): [string | null, string] {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const stripped = lines[index]!.trim();
    if (stripped.startsWith("# ")) {
      const title = stripped.slice(2).trim();
      let remaining = lines.slice(index + 1);
      if (remaining.length && remaining[0]!.trim() === "") {
        remaining = remaining.slice(1);
      }
      return [title, remaining.join("\n")];
    }
  }
  return [null, content];
}

/** Call the ClickUp Docs API to update a page. */
export async function updatePage(
  workspaceId: string,
  docId: string,
  pageId: string,
  content: string,
  apiToken: string,
  editMode: EditMode = "replace",
  name: string | null = null,
  subTitle: string | null = null,
): Promise<unknown> {
  const url = `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`;
  const data: Record<string, unknown> = {
    content,
    content_format: "text/md",
    content_edit_mode: editMode,
  };
  if (name !== null) {
    data.name = name;
  }
  if (subTitle !== null) {
    data.sub_title = subTitle;
  }

  const body = await httpRequest(url, {
    method: "PUT",
    headers: {
      Authorization: apiToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(data),
  });
  return body ? parseJson(body) : {};
}

/** Fetch a ClickUp Doc page. */
export async function getPage(
  workspaceId: string,
  docId: string,
  pageId: string,
  apiToken: string,
  contentFormat: "text/plain" | "text/md" = "text/plain",
): Promise<unknown> {
  const query = pyUrlencode({ content_format: contentFormat });
  const url = `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}?${query}`;
  const body = await httpRequest(url, {
    headers: { Authorization: apiToken, Accept: "application/json" },
    timeoutMs: 15_000,
  });
  return parseJson(body);
}

export const PROG = "clickup-update-page";

const USAGE = `usage: clickup-update-page [-h] [--workspace-id ID] [--doc-id ID]
                           [--page-id ID] [--append | --prepend] [--no-open]
                           [--no-rich-links] [--allow-local-media]
                           [URL_OR_FILE] [FILE]
`;

const HELP = `${USAGE}
Update a ClickUp Doc page from a markdown file.

positional arguments:
  URL_OR_FILE          ClickUp page URL, or markdown file with clickup-page
                       metadata
  FILE                 Markdown file to upload when URL is the first
                       positional argument

options:
  -h, --help           show this help message and exit
  --workspace-id ID    ClickUp workspace ID
  --doc-id ID          ClickUp doc ID
  --page-id ID         ClickUp page ID
  --append             Append content instead of replacing it
  --prepend            Prepend content instead of replacing it
  --no-open            Do not open the page in a browser after a successful
                       update
  --no-rich-links      Do not rewrite bare ClickUp/Figma URLs into Markdown
                       links/previews
  --allow-local-media  Update even when Markdown contains local media paths
                       that ClickUp cannot render

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
`;

export const CLI: CliSpec = {
  prog: PROG,
  usage: USAGE,
  help: HELP,
  maxPositionals: 2,
  options: {
    help: { type: "boolean", short: "h" },
    "workspace-id": { type: "string" },
    "doc-id": { type: "string" },
    "page-id": { type: "string" },
    append: { type: "boolean" },
    prepend: { type: "boolean" },
    "no-open": { type: "boolean" },
    "no-rich-links": { type: "boolean" },
    "allow-local-media": { type: "boolean" },
  },
};

export interface PageArgs {
  workspaceId?: string;
  docId?: string;
  pageId?: string;
  urlOrFile?: string;
  file?: string;
}

/** Return [workspaceId, docId, pageId, markdownFilePath]. */
export function resolveArgs(args: PageArgs): [string, string, string, string] {
  if (args.workspaceId && args.docId && args.pageId) {
    const markdownFile = args.urlOrFile || args.file;
    if (!markdownFile) {
      throw new ValueError("Markdown file path is required.");
    }
    return [args.workspaceId, args.docId, args.pageId, markdownFile];
  }

  if (args.urlOrFile && args.urlOrFile.startsWith("http")) {
    if (!args.file) {
      throw new ValueError("Markdown file path is required after the URL.");
    }
    const [workspaceId, docId, pageId] = parsePageUrl(args.urlOrFile);
    return [workspaceId, docId, pageId, args.file];
  }

  if (args.urlOrFile && !args.file) {
    const [workspaceId, docId, pageId] = readClickupPageFromMetadata(args.urlOrFile);
    return [workspaceId, docId, pageId, args.urlOrFile];
  }

  throw new ValueError(
    "Provide either a ClickUp page URL followed by a markdown file, " +
      "a markdown file with clickup-page metadata, " +
      "or use --workspace-id / --doc-id / --page-id.",
  );
}

/** Resolve the ClickUp content edit mode from parsed arguments. */
export function getEditMode(args: { append?: boolean; prepend?: boolean }): EditMode {
  if (args.append) return "append";
  if (args.prepend) return "prepend";
  return "replace";
}

/** Parse simple YAML-style front matter from Markdown content. */
export function parseFrontMatter(content: string): [Record<string, string>, string] {
  const lines = pySplitlines(content, true);
  if (!lines.length || lines[0]!.trim() !== "---") {
    return [{}, content];
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]!.trim() === "---") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    return [{}, content];
  }

  const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of lines.slice(1, closingIndex)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes(":")) continue;

    const separator = stripped.indexOf(":");
    metadata[stripped.slice(0, separator).trim()] = cleanMetadataValue(stripped.slice(separator + 1));
  }

  return [metadata, lines.slice(closingIndex + 1).join("")];
}

/**
 * Set front matter keys in a Markdown file, replacing existing lines for the
 * same keys or adding them before the closing `---` (creating the block when
 * the file has none). The file's line ending style is kept.
 */
export function setFrontMatterValues(filePath: string, entries: Array<[string, string]>): void {
  const raw = fs.readFileSync(filePath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const newLines = (pending: Array<[string, string]>) => pending.map(([key, value]) => `${key}: ${value}`);

  const closing = lines[0]?.trim() === "---" ? lines.findIndex((line, index) => index > 0 && line.trim() === "---") : -1;
  if (closing === -1) {
    fs.writeFileSync(filePath, ["---", ...newLines(entries), "---", ""].join(eol) + raw, "utf8");
    return;
  }

  const pending = new Map(entries);
  for (let index = 1; index < closing; index++) {
    const key = lines[index]!.split(":", 1)[0]!.trim();
    if (pending.has(key)) {
      lines[index] = `${key}: ${pending.get(key)}`;
      pending.delete(key);
    }
  }
  lines.splice(closing, 0, ...newLines([...pending]));
  fs.writeFileSync(filePath, lines.join(eol), "utf8");
}

const DOC_URL_RE = /app\.clickup\.com\/([^/]+)\/(?:v\/dc|docs)\/([^/?#]+)/;

/** Return [workspaceId, docId] from a ClickUp Doc URL (with or without a page). */
export function parseDocUrl(url: string): [string, string] {
  const match = DOC_URL_RE.exec(url);
  if (!match) {
    throw new ValueError(
      `Cannot parse ClickUp Doc URL: ${pyRepr(url)}\nExpected: https://app.clickup.com/<workspace_id>/v/dc/<doc_id>`,
    );
  }
  return [match[1]!, match[2]!];
}

/** Where a new page goes: the Doc from clickup-doc, optionally under clickup-parent-page. */
export interface CreatePageTarget {
  workspaceId: string;
  docId: string;
  parentPageId: string;
}

/** A create target when front matter has clickup-doc but no clickup-page; otherwise null. */
export function readCreatePageTarget(filePath: string): CreatePageTarget | null {
  const [metadata] = parseFrontMatter(readMarkdown(filePath));
  if (metadata["clickup-page"] || !metadata["clickup-doc"]) return null;
  const [workspaceId, docId] = parseDocUrl(metadata["clickup-doc"]);
  const parent = (metadata["clickup-parent-page"] ?? "").trim();
  return { workspaceId, docId, parentPageId: parent.startsWith("http") ? parsePageUrl(parent)[2] : parent };
}

/** Create a page in a Doc and return its ID. */
export async function createPage(
  target: CreatePageTarget,
  page: { name: string; content: string; subTitle: string | null },
  apiToken: string,
): Promise<string> {
  const data: Record<string, unknown> = { name: page.name, content: page.content, content_format: "text/md" };
  if (page.subTitle) data.sub_title = page.subTitle;
  if (target.parentPageId) data.parent_page_id = target.parentPageId;
  const body = await httpRequest(`https://api.clickup.com/api/v3/workspaces/${target.workspaceId}/docs/${target.docId}/pages`, {
    method: "POST",
    headers: { Authorization: apiToken, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(data),
  });
  const created = body ? parseJson(body) : {};
  const id = [created, isDict(created) ? created.page : null, isDict(created) ? created.data : null]
    .map((candidate) => (isDict(candidate) && typeof candidate.id === "string" ? candidate.id.trim() : ""))
    .find(Boolean);
  if (!id) throw new ValueError("ClickUp did not return the new page ID.");
  return id;
}

/** Read clickup-page front matter from a Markdown file. */
export function readClickupPageFromMetadata(filePath: string): [string, string, string] {
  const [metadata] = parseFrontMatter(readMarkdown(filePath));
  const pageUrl = metadata["clickup-page"];
  if (!pageUrl) {
    throw new ValueError(
      `No clickup-page metadata found in ${pyRepr(filePath)}. ` +
        "Add front matter like: clickup-page: https://app.clickup.com/<workspace_id>/v/dc/<doc_id>/<page_id>",
    );
  }
  return parsePageUrl(pageUrl);
}

/** Read Markdown and prepare it for the ClickUp Docs API. */
export async function prepareMarkdownContent(
  markdownPath: string,
  apiToken: string,
  { richLinks = true }: { richLinks?: boolean } = {},
): Promise<PreparedContent> {
  const [metadata, content] = parseFrontMatter(readMarkdown(markdownPath));
  const prepared: PreparedContent = {
    content,
    localMediaRefs: findLocalMediaReferences(content, path.dirname(markdownPath)),
    normalizedLinks: 0,
    subtitle: (metadata.subtitle ?? "").trim() || null,
  };

  if (richLinks) {
    const [linkified, normalizedCount] = await linkifyBareUrls(prepared.content, createLinkContext(apiToken));
    prepared.content = linkified;
    prepared.normalizedLinks = normalizedCount;
  }
  return prepared;
}

/** Find local Markdown media references ClickUp cannot render from API uploads. */
export function findLocalMediaReferences(content: string, markdownDir: string): string[] {
  const refs: string[] = [];
  for (const match of content.matchAll(new RegExp(MARKDOWN_IMAGE_SOURCE, "g"))) {
    const rawTarget = normalizeMarkdownUrl(match[2]!);
    if (!isLocalAssetReference(rawTarget)) continue;

    const assetPath = resolveAssetPath(rawTarget, markdownDir);
    refs.push(isFile(assetPath) ? assetPath : `${rawTarget} (file not found)`);
  }
  return refs;
}

/** Strip Markdown angle brackets from a URL/path. */
export function normalizeMarkdownUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/** Return whether a Markdown target is a local file reference. */
export function isLocalAssetReference(target: string): boolean {
  if (!target || target.startsWith("#")) return false;
  return urlScheme(target) === "";
}

/** Resolve a Markdown local asset path relative to its document. */
export function resolveAssetPath(target: string, markdownDir: string): string {
  const assetPath = expandUser(pyUnquote(target));
  if (path.isAbsolute(assetPath)) return path.normalize(assetPath);
  return path.join(markdownDir, assetPath);
}

/** Convert bare ClickUp/Figma URLs into Markdown links or previews. */
export async function linkifyBareUrls(content: string, context: LinkContext): Promise<[string, number]> {
  let normalizedCount = 0;
  let inFence = false;
  const output: string[] = [];

  for (const line of pySplitlines(content, true)) {
    const stripped = line.trim();
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      inFence = !inFence;
      output.push(line);
      continue;
    }
    if (inFence) {
      output.push(line);
      continue;
    }

    const lineOnlyUrl = getSingleBareUrl(line);
    let rebuilt = "";
    let last = 0;
    for (const match of line.matchAll(new RegExp(URL_SOURCE, "g"))) {
      const raw = match[0];
      rebuilt += line.slice(last, match.index);
      last = match.index + raw.length;

      if (isUrlAlreadyLinked(line, match.index)) {
        rebuilt += raw;
        continue;
      }

      const [url, trailing] = splitTrailingUrlPunctuation(raw);
      const replacement = await formatSpecialUrl(url, context, lineOnlyUrl === url);
      if (replacement === url) {
        rebuilt += raw;
        continue;
      }

      normalizedCount++;
      rebuilt += replacement + trailing;
    }
    output.push(rebuilt + line.slice(last));
  }

  return [output.join(""), normalizedCount];
}

/** Return the URL when a line consists of only one bare URL. */
export function getSingleBareUrl(line: string): string | null {
  const stripped = line.trim();
  const matches = Array.from(stripped.matchAll(new RegExp(URL_SOURCE, "g")));
  if (matches.length !== 1) return null;

  const match = matches[0]!;
  const [url, trailing] = splitTrailingUrlPunctuation(match[0]);
  if (trailing) return null;
  if (match.index === 0 && match[0].length === stripped.length) return url;
  return null;
}

/** Avoid rewriting URLs already inside Markdown links or inline code. */
export function isUrlAlreadyLinked(line: string, start: number): boolean {
  const prefix = line.slice(0, start);
  if (prefix.endsWith("](") || prefix.endsWith("](<") || prefix.endsWith("<")) {
    return true;
  }
  return (prefix.split("`").length - 1) % 2 === 1;
}

function countChar(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Separate punctuation that belongs to the sentence, not the URL. */
export function splitTrailingUrlPunctuation(rawUrl: string): [string, string] {
  let url = rawUrl;
  let trailing = "";

  while (url && TRAILING_URL_PUNCTUATION.includes(url[url.length - 1]!)) {
    trailing = url[url.length - 1] + trailing;
    url = url.slice(0, -1);
  }

  while (url.endsWith(")") && countChar(url, "(") < countChar(url, ")")) {
    trailing = `)${trailing}`;
    url = url.slice(0, -1);
  }

  return [url, trailing];
}

function urlHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function urlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** Format a URL that ClickUp should receive as a richer Markdown block. */
export async function formatSpecialUrl(url: string, context: LinkContext, lineOnly = false): Promise<string> {
  const hostname = urlHostname(url);
  if (hostname.endsWith("clickup.com")) {
    return markdownLink(await getClickupLinkLabel(url, context), url);
  }
  if (hostname.endsWith("figma.com")) {
    return formatFigmaUrl(url, context, { lineOnly });
  }
  return url;
}

/** Resolve a ClickUp Doc URL to its page name when possible. */
export async function getClickupLinkLabel(url: string, context: LinkContext): Promise<string> {
  const cached = context.clickupTitles.get(url);
  if (cached !== undefined) return cached;

  let label = "ClickUp page";
  try {
    const [workspaceId, docId, pageId] = parsePageUrl(url);
    const page = await getPage(workspaceId, docId, pageId, context.apiToken);
    label = extractPageName(page) || label;
  } catch {
    // Keep the generic label.
  }

  context.clickupTitles.set(url, label);
  return label;
}

/** Extract a page name from likely ClickUp response shapes. */
export function extractPageName(page: unknown): string {
  if (!isDict(page)) return "";

  for (const key of ["name", "title"]) {
    const value = page[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  for (const containerKey of ["page", "data"]) {
    const name = extractPageName(page[containerKey]);
    if (name) return name;
  }
  return "";
}

function metadataText(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

/** Create a readable Figma link, with a linked thumbnail when available. */
export async function formatFigmaUrl(
  url: string,
  context: LinkContext,
  { lineOnly = false }: { lineOnly?: boolean } = {},
): Promise<string> {
  const metadata = await getFigmaOembed(url, context);
  const label = metadataText(metadata, "title") || inferFigmaLabel(url);
  const thumbnailUrl = metadataText(metadata, "thumbnail_url");

  if (lineOnly && thumbnailUrl) {
    const image = markdownImage(`Figma preview: ${label}`, thumbnailUrl);
    return `${markdownLinkRawLabel(image, url)}\n${markdownLink(label, url)}`;
  }
  return markdownLink(label, url);
}

/** Fetch Figma oEmbed metadata when available. */
export async function getFigmaOembed(url: string, context: LinkContext): Promise<Record<string, unknown>> {
  const cached = context.figmaOembed.get(url);
  if (cached !== undefined) return cached;

  let metadata: Record<string, unknown> = {};
  const query = pyUrlencode({ url, maxwidth: "960", maxheight: "540" });
  try {
    const body = await httpRequest(`https://api.figma.com/v1/oembed?${query}`, {
      headers: { Accept: "application/json" },
      timeoutMs: 15_000,
    });
    const loaded = parseJson(body);
    if (isDict(loaded)) metadata = loaded;
  } catch {
    metadata = {};
  }

  context.figmaOembed.set(url, metadata);
  return metadata;
}

/** Infer a compact Figma link label from the URL path. */
export function inferFigmaLabel(url: string): string {
  const pathname = urlPathname(url).toLowerCase();
  if (pathname.includes("/proto/")) return "Figma prototype";
  if (pathname.includes("/design/")) return "Figma design";
  if (pathname.includes("/figjam/")) return "FigJam board";
  return "Figma";
}

/** Build a Markdown link with URL angle brackets for query-heavy URLs. */
export function markdownLink(label: string, url: string): string {
  return `[${escapeMarkdownLabel(label)}](<${url}>)`;
}

/** Build a Markdown link whose label already contains Markdown. */
export function markdownLinkRawLabel(label: string, url: string): string {
  return `[${label}](<${url}>)`;
}

/** Build a Markdown image. */
export function markdownImage(altText: string, url: string): string {
  return `![${escapeMarkdownLabel(altText)}](<${url}>)`;
}

/** Escape square brackets in a Markdown label. */
export function escapeMarkdownLabel(label: string): string {
  return label.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** Read a Markdown file as UTF-8 text with universal newlines. */
export function readMarkdown(filePath: string, stripMetadata = false): string {
  if (!pathExists(filePath)) {
    throw new FileNotFoundError(`File not found: ${filePath}`);
  }
  const content = normalizeNewlines(fs.readFileSync(filePath, "utf8"));
  if (stripMetadata) {
    return parseFrontMatter(content)[1];
  }
  return content;
}

/** argparse's mutually exclusive group error names the later of --append/--prepend. */
function validateEditModeFlags(parsed: ParsedCli): string | null {
  const modes = parsed.optionOrder.filter((name) => name === "append" || name === "prepend");
  const first = modes[0];
  const conflict = modes.find((name) => name !== first);
  return conflict ? `argument --${conflict}: not allowed with argument --${first}` : null;
}

/** Run the CLI and return a process exit code. */
export async function run(argv: readonly string[], io: Output = processOutput): Promise<number> {
  const parsed = parseCli(CLI, argv, io, { validate: validateEditModeFlags });
  if (typeof parsed === "number") return parsed;

  const options = {
    append: flagOption(parsed, "append"),
    prepend: flagOption(parsed, "prepend"),
    noOpen: flagOption(parsed, "no-open"),
    noRichLinks: flagOption(parsed, "no-rich-links"),
    allowLocalMedia: flagOption(parsed, "allow-local-media"),
  };

  const args: PageArgs = {
    workspaceId: stringOption(parsed, "workspace-id"),
    docId: stringOption(parsed, "doc-id"),
    pageId: stringOption(parsed, "page-id"),
    urlOrFile: parsed.positionals[0],
    file: parsed.positionals[1],
  };

  if (!args.urlOrFile) {
    io.stdout(HELP);
    return 0;
  }

  let workspaceId: string;
  let docId: string;
  let pageId: string;
  let markdownFile: string;
  let createTarget: CreatePageTarget | null = null;
  try {
    // A file with clickup-doc but no clickup-page creates a new page in that Doc.
    const fileOnly = !args.file && !args.urlOrFile.startsWith("http") && !(args.workspaceId && args.docId && args.pageId);
    createTarget = fileOnly ? readCreatePageTarget(args.urlOrFile) : null;
    if (createTarget) {
      [workspaceId, docId, pageId, markdownFile] = [createTarget.workspaceId, createTarget.docId, "", args.urlOrFile];
    } else {
      [workspaceId, docId, pageId, markdownFile] = resolveArgs(args);
    }
  } catch (error) {
    if (error instanceof FileNotFoundError || error instanceof ValueError) {
      err(io, error.message);
      return 1;
    }
    throw error;
  }

  const apiToken = getApiToken();
  if (!apiToken) {
    printMissingTokenHelp(io);
    return 1;
  }

  let prepared: PreparedContent;
  try {
    prepared = await prepareMarkdownContent(markdownFile, apiToken, { richLinks: !options.noRichLinks });
  } catch (error) {
    if (error instanceof FileNotFoundError) {
      err(io, error.message);
      return 1;
    }
    throw error;
  }

  const content = prepared.content;
  info(io, `File   : ${pyResolve(markdownFile)} (${formatThousands(pyLen(content))} chars)`);
  if (createTarget) {
    const parent = createTarget.parentPageId ? `  parent=${createTarget.parentPageId}` : "";
    info(io, `Target : workspace=${workspaceId}  doc=${docId}  (new page${parent})`);
  } else {
    info(io, `Target : workspace=${workspaceId}  doc=${docId}  page=${pageId}`);
  }
  info(io, `Media  : local_refs=${prepared.localMediaRefs.length}`);
  for (const localRef of prepared.localMediaRefs) {
    info(io, `Local  : ${localRef}`);
  }
  if (!options.noRichLinks) {
    info(io, `Links  : normalized=${prepared.normalizedLinks}`);
  }

  if (prepared.localMediaRefs.length && !options.allowLocalMedia) {
    err(io, "Local media references cannot be rendered by ClickUp Docs API uploads.");
    err(io, "Replace them with public/hosted URLs, remove them, or rerun with --allow-local-media.");
    return 1;
  }

  const editMode = getEditMode(options);
  info(io, `Mode   : ${createTarget ? "create" : editMode}`);

  const [title, body] = extractTitle(content);
  if (title) {
    info(io, `Title  : ${title}`);
  }
  if (prepared.subtitle) {
    info(io, `Subtitle: ${prepared.subtitle}`);
  }
  if (createTarget && !title) {
    err(io, "A new page needs a name: start the Markdown with a `# Page name` heading.");
    return 1;
  }
  print(io);

  try {
    if (createTarget) {
      pageId = await createPage(createTarget, { name: title!, content: body, subTitle: prepared.subtitle }, apiToken);
      // Record the page first so a re-run updates it instead of creating another.
      const newUrl = buildPageUrl(workspaceId, docId, pageId);
      try {
        setFrontMatterValues(markdownFile, [["clickup-page", newUrl]]);
      } catch (writeError) {
        err(io, `Page created at ${newUrl}, but saving clickup-page to ${markdownFile} failed: ${errorMessage(writeError)}`);
        err(io, "Add that clickup-page line to the front matter yourself before running again.");
        return 1;
      }
    } else {
      await updatePage(workspaceId, docId, pageId, body, apiToken, editMode, title, prepared.subtitle);
    }
  } catch (error) {
    if (error instanceof HttpError) return reportHttpError(error, io);
    if (error instanceof NetworkError) {
      err(io, `Network error: ${error.reason}`);
      return 1;
    }
    err(io, `Unexpected error: ${errorMessage(error)}`);
    return 1;
  }

  const pageUrl = buildPageUrl(workspaceId, docId, pageId);
  print(io);
  if (createTarget) {
    ok(io, "Page created");
    ok(io, `Saved clickup-page to ${markdownFile}`);
  } else {
    ok(io, `Page updated (${editMode})`);
  }
  ok(io, `URL: ${BOLD}${pageUrl}${RESET}`);

  if (!options.noOpen) {
    info(io, "Opening in browser...");
    openBrowser(pageUrl);
  }
  return 0;
}

/** CLI entry point. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await run(argv);
}
