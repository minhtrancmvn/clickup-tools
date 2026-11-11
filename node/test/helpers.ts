import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { vi } from "vitest";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  signal: AbortSignal | undefined;
}

export type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

/** Replace global fetch with a handler; returns the recorded calls. */
export function stubFetch(handler: FetchHandler): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const call: FetchCall = {
        url: String(input),
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body as string | Uint8Array | undefined,
        signal: init.signal ?? undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch rejection like undici's when the network is unreachable. */
export function networkFailure(reason: string): never {
  throw new TypeError("fetch failed", { cause: new Error(reason) });
}

export function bodyJson(call: FetchCall): unknown {
  const body = typeof call.body === "string" ? call.body : Buffer.from(call.body ?? new Uint8Array()).toString("utf8");
  return JSON.parse(body);
}

/** Create a temporary directory inside the per-test sandbox (removed after each test). */
export function tempDir(): string {
  return fs.mkdtempSync(path.join(process.cwd(), "case-"));
}
