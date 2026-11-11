/**
 * Per-test isolation: no ambient ClickUp/Telegram env vars, no .env pickup from
 * the real working directory, and no real network access.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, vi } from "vitest";

const ISOLATED_ENV_VARS = [
  "CLICKUP_API_TOKEN",
  "CLICKUP_TEAM_ID",
  "CLICKUP_TASK_ID",
  "CLICKUP_OUTCOME_FIELD_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_THREAD_ID",
];

let sandbox = "";

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clickup-tools-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(sandbox);
  vi.stubEnv("CLICKUP_TOOLS_ENV_FILE", path.join(sandbox, "missing.env"));
  for (const name of ISOLATED_ENV_VARS) {
    vi.stubEnv(name, "");
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      throw new Error(`Unexpected network request in test: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});
