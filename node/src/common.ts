/**
 * Shared helpers: terminal output, errors, HTTP, CLI parsing, and small
 * Python-compatible string/path utilities used to keep behaviour identical to
 * the original Python implementation.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { STATUS_CODES } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const GREEN = "\x1b[92m";
export const RED = "\x1b[91m";
export const CYAN = "\x1b[96m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";

/** Where a command writes its output. The MCP server passes a buffer because stdout carries JSON-RPC. */
export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processOutput: Output = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export class BufferedOutput implements Output {
  out = "";
  err = "";

  stdout(text: string): void {
    this.out += text;
  }

  stderr(text: string): void {
    this.err += text;
  }
}

export function print(io: Output, message = ""): void {
  io.stdout(`${message}\n`);
}

export function ok(io: Output, message: string): void {
  io.stdout(`${GREEN}[ok]${RESET} ${message}\n`);
}

export function err(io: Output, message: string): void {
  io.stderr(`${RED}[error]${RESET} ${message}\n`);
}

export function info(io: Output, message: string): void {
  io.stdout(`${CYAN}->${RESET} ${message}\n`);
}

export function printMissingTokenHelp(io: Output): void {
  err(io, "CLICKUP_API_TOKEN is not set.");
  err(io, "  export CLICKUP_API_TOKEN=pk_...");
  err(io, "  Or add it to a local .env file.");
  err(io, "  Get yours at: https://app.clickup.com/settings/apps");
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Invalid input or response data (mirrors Python's ValueError). */
export class ValueError extends Error {
  override name = "ValueError";
}

/** A referenced local file does not exist (mirrors Python's FileNotFoundError). */
export class FileNotFoundError extends Error {
  override name = "FileNotFoundError";
}

/** A non-2xx HTTP response (mirrors urllib.error.HTTPError). */
export class HttpError extends Error {
  override name = "HttpError";

  constructor(
    readonly code: number,
    readonly reason: string,
    readonly body: string,
  ) {
    super(`HTTP Error ${code}: ${reason}`);
  }
}

/** The request never produced an HTTP response (mirrors urllib.error.URLError). */
export class NetworkError extends Error {
  override name = "NetworkError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Omit for no timeout (matches urlopen calls without a timeout). */
  timeoutMs?: number;
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timed out";
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return cause.message;
    }
    return error.message;
  }
  return String(error);
}

/** Perform an HTTP request and return the response body text. */
export async function httpRequest(url: string, options: RequestOptions = {}): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });
  } catch (error) {
    throw new NetworkError(describeFetchError(error));
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new NetworkError(describeFetchError(error));
  }

  if (!response.ok) {
    const reason = response.statusText || STATUS_CODES[response.status] || "";
    throw new HttpError(response.status, reason, text);
  }
  return text;
}

/** Parse JSON, raising ValueError like Python's json.loads. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ValueError(`Invalid JSON response: ${errorMessage(error)}`);
  }
}

/** Print a readable ClickUp HTTP error and return a failing exit code. */
export function reportHttpError(error: HttpError, io: Output): number {
  err(io, `API error ${error.code} ${error.reason}`);
  err(io, `  ${formatErrorDetail(error.body)}`);
  return 1;
}

function formatErrorDetail(body: string): string {
  try {
    const detail: unknown = JSON.parse(body);
    if (isDict(detail)) {
      return "err" in detail ? pyStr(detail.err) : pyJsonDumps(detail);
    }
  } catch {
    // Fall through to the raw body.
  }
  return Array.from(body).slice(0, 300).join("");
}

// ---------------------------------------------------------------------------
// CLI parsing (argparse-compatible behaviour on top of util.parseArgs)
// ---------------------------------------------------------------------------

export type CliOptions = NonNullable<ParseArgsConfig["options"]>;

export type UsageSpec = Pick<CliSpec, "prog" | "usage">;

export interface CliSpec {
  prog: string;
  /** argparse-style usage block, ending in a newline. */
  usage: string;
  /** Full help text, ending in a newline. */
  help: string;
  options: CliOptions;
  maxPositionals: number;
  /** For a subcommand: the parser that reports unrecognized arguments, as argparse's top-level parser does. */
  parent?: UsageSpec;
}

export interface ParsedCli {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  /** Known option names in the order they appeared. */
  optionOrder: string[];
  /** Unknown options and surplus positionals, in argv order. */
  extras: string[];
}

/** Command-specific checks (types, required args, exclusions); returns an argparse error message or null. */
export type CliValidator = (parsed: ParsedCli) => string | null;

export interface ParseCliOptions {
  validate?: CliValidator;
  /** Unrecognized arguments already collected by a parent parser. */
  extras?: readonly string[];
}

const NEGATIVE_NUMBER_RE = /^-\d+$|^-\d*\.\d+$/;

/** Whether argparse would classify a string as an option rather than a value. */
function isOptionLike(value: string): boolean {
  return value.length > 1 && value.startsWith("-") && !NEGATIVE_NUMBER_RE.test(value) && !value.includes(" ");
}

/** Expand unique long-option prefixes (`--task` -> `--task-id`) like argparse's allow_abbrev. */
function expandAbbreviations(argv: readonly string[], options: CliOptions): string[] | { error: string } {
  const flags = Object.keys(options).map((name) => `--${name}`);
  const expanded: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") {
      expanded.push(...argv.slice(index));
      break;
    }
    if (!arg.startsWith("--")) {
      expanded.push(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (flags.includes(flag)) {
      expanded.push(arg);
      continue;
    }
    const matches = flags.filter((candidate) => candidate.startsWith(flag));
    if (matches.length > 1) {
      return { error: `ambiguous option: ${arg} could match ${matches.join(", ")}` };
    }
    expanded.push(matches.length === 1 ? matches[0]! + (separator === -1 ? "" : arg.slice(separator)) : arg);
  }
  return expanded;
}

export function usageError(spec: UsageSpec, io: Output, message: string): number {
  io.stderr(`${spec.usage}${spec.prog}: error: ${message}\n`);
  return 2;
}

/**
 * Parse argv with argparse semantics: option-value errors first, then the
 * command's validator, then unrecognized arguments (reported by the parent
 * parser for subcommands). Returns an exit code when help was shown or
 * parsing failed.
 */
export function parseCli(
  spec: CliSpec,
  argv: readonly string[],
  io: Output,
  { validate, extras = [] }: ParseCliOptions = {},
): ParsedCli | number {
  const expanded = expandAbbreviations(argv, spec.options);
  if (!Array.isArray(expanded)) return usageError(spec, io, expanded.error);

  const terminator = expanded.indexOf("--");
  const head = terminator === -1 ? expanded : expanded.slice(0, terminator);
  if (head.includes("-h") || head.includes("--help")) {
    io.stdout(spec.help);
    return 0;
  }

  const { tokens } = parseArgs({
    args: expanded,
    options: spec.options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const parsed: ParsedCli = { values: {}, positionals: [], optionOrder: [], extras: [...extras] };
  const unknownIndexes = new Set<number>();
  for (const token of tokens) {
    if (token.kind === "positional") {
      if (parsed.positionals.length < spec.maxPositionals) parsed.positionals.push(token.value);
      else parsed.extras.push(token.value);
      continue;
    }
    if (token.kind !== "option") continue;

    const option = Object.hasOwn(spec.options, token.name) ? spec.options[token.name] : undefined;
    if (!option) {
      if (!unknownIndexes.has(token.index)) {
        unknownIndexes.add(token.index);
        parsed.extras.push(expanded[token.index]!);
      }
      continue;
    }

    const flag = `--${token.name}`;
    if (option.type === "string") {
      if (token.value === undefined || (!token.inlineValue && isOptionLike(token.value))) {
        return usageError(spec, io, `argument ${flag}: expected one argument`);
      }
      parsed.values[token.name] = token.value;
    } else {
      if (token.inlineValue && token.value !== undefined) {
        return usageError(spec, io, `argument ${flag}: ignored explicit argument ${pyRepr(token.value)}`);
      }
      parsed.values[token.name] = true;
    }
    parsed.optionOrder.push(token.name);
  }

  const problem = validate?.(parsed);
  if (problem) return usageError(spec, io, problem);
  if (parsed.extras.length) {
    return usageError(spec.parent ?? spec, io, `unrecognized arguments: ${parsed.extras.join(" ")}`);
  }
  return parsed;
}

export function stringOption(parsed: ParsedCli, name: string): string {
  const value = parsed.values[name];
  return typeof value === "string" ? value : "";
}

export function flagOption(parsed: ParsedCli, name: string): boolean {
  return parsed.values[name] === true;
}

// ---------------------------------------------------------------------------
// Python-compatible helpers
// ---------------------------------------------------------------------------

export function isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python truthiness for JSON values. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python `a or b or c` over JSON values. */
export function pyOr(...values: unknown[]): unknown {
  for (const value of values) {
    if (pyTruthy(value)) return value;
  }
  return values[values.length - 1];
}

/** Python str() for JSON values. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return pyJsonDumps(value);
}

/** Python repr() for strings. */
export function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  if (quote === "'") escaped = escaped.replace(/'/g, "\\'");
  return `${quote}${escaped}${quote}`;
}

/** json.dumps with Python's default separators (", " and ": "). */
export function pyJsonDumps(value: unknown, sortKeys = false): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => pyJsonDumps(item, sortKeys)).join(", ")}]`;
  }
  if (isDict(value)) {
    const keys = Object.keys(value);
    if (sortKeys) keys.sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}: ${pyJsonDumps(value[key], sortKeys)}`);
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Python int() for JSON values; null where Python raises. */
export function pyInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && /^\s*[+-]?\d+(?:_\d+)*\s*$/.test(value)) {
    return Number(value.trim().replace(/_/g, ""));
  }
  return null;
}

/** Python float() for JSON values; null where Python raises. */
export function pyFloat(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/_/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(text)) return Number.NaN;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return Number(text);
  return null;
}

/** Length in code points, like Python len(str). */
export function pyLen(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Slice by code points, like Python str[start:end]. */
export function pySlice(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join("");
}

const LINE_BOUNDARY_RE = new RegExp(String.raw`\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]`, "g");

/** Python str.splitlines(). */
export function pySplitlines(text: string, keepends = false): string[] {
  const lines: string[] = [];
  let last = 0;
  for (const match of text.matchAll(LINE_BOUNDARY_RE)) {
    const end = match.index + match[0].length;
    lines.push(text.slice(last, keepends ? end : match.index));
    last = end;
  }
  if (last < text.length) lines.push(text.slice(last));
  return lines;
}

/** Python text-mode reads translate \r\n and \r to \n. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Group digits with commas, like Python f"{n:,}". */
export function formatThousands(value: number): string {
  const sign = value < 0 ? "-" : "";
  return sign + String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** urllib.parse.quote_plus. */
export function pyQuotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** urllib.parse.urlencode for a flat mapping of strings. */
export function pyUrlencode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${pyQuotePlus(key)}=${pyQuotePlus(value)}`)
    .join("&");
}

/** urllib.parse.unquote: decode %XX runs as UTF-8, replacing invalid bytes. */
export function pyUnquote(value: string): string {
  if (!value.includes("%")) return value;
  const decoder = new TextDecoder("utf-8");
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number.parseInt(run.slice(index * 3 + 1, index * 3 + 3), 16);
    }
    return decoder.decode(bytes);
  });
}

/** The scheme urllib.parse.urlparse would report ("" for local paths). */
export function urlScheme(target: string): string {
  const cleaned = target.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  const index = cleaned.indexOf(":");
  if (index > 0) {
    const scheme = cleaned.slice(0, index);
    if (/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) return scheme.toLowerCase();
  }
  return "";
}

/** html.escape. */
export function htmlEscape(value: string, quote = true): string {
  let escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (quote) escaped = escaped.replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  return escaped;
}

/** Path.expanduser for "~" and "~/..." paths. */
export function expandUser(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Path.resolve(strict=False): absolute, with symlinks resolved for the existing prefix. */
export function pyResolve(value: string): string {
  const absolute = path.resolve(value);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function pathExists(value: string): boolean {
  return fs.existsSync(value);
}

export function isFile(value: string): boolean {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Open a URL in the default browser without blocking or failing the command. */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening the browser is best-effort.
  }
}

const MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  gz: "application/gzip",
  heic: "image/heic",
  htm: "text/html",
  html: "text/html",
  ico: "image/vnd.microsoft.icon",
  jpe: "image/jpeg",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  m4a: "audio/mp4",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  wav: "audio/x-wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "text/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

/** Guess a file's MIME type from its extension (mimetypes.guess_type). */
export function guessMimeType(filename: string): string {
  const extension = path.extname(filename).slice(1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}
