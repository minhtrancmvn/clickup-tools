/** Environment and .env lookups. */

import fs from "node:fs";
import path from "node:path";

import { expandUser, pyResolve, pySplitlines } from "./common.js";

export const ENV_FILE_ENV_VAR = "CLICKUP_TOOLS_ENV_FILE";

/** Normalize a scalar front matter / dotenv value (strip matching quotes). */
export function cleanMetadataValue(value: string): string {
  const cleaned = value.trim();
  if (cleaned.length >= 2 && cleaned[0] === cleaned[cleaned.length - 1] && (cleaned[0] === "'" || cleaned[0] === '"')) {
    return cleaned.slice(1, -1);
  }
  return cleaned;
}

/** .env locations to check: the explicit --env-file first, then ./.env. */
export function getEnvFileCandidates(): string[] {
  const candidates: string[] = [];
  const explicit = (process.env[ENV_FILE_ENV_VAR] ?? "").trim();
  if (explicit) {
    candidates.push(expandUser(explicit));
  }
  candidates.push(path.join(process.cwd(), ".env"));

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of candidates) {
    const resolved = pyResolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      deduped.push(candidate);
    }
  }
  return deduped;
}

/** Read one variable from a dotenv-style file. */
export function readValueFromEnvFile(filePath: string, name: string): string {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }

  for (const line of pySplitlines(text)) {
    let stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;

    if (stripped.startsWith("export ")) {
      stripped = stripped.slice("export ".length).trim();
    }

    const separator = stripped.indexOf("=");
    if (separator !== -1 && stripped.slice(0, separator).trim() === name) {
      return cleanMetadataValue(stripped.slice(separator + 1));
    }
  }
  return "";
}

export function readApiTokenFromEnvFile(filePath: string): string {
  return readValueFromEnvFile(filePath, "CLICKUP_API_TOKEN");
}

/** Read a value from the environment or a local .env file. */
export function getEnvValue(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value) return value;

  for (const envPath of getEnvFileCandidates()) {
    const fileValue = readValueFromEnvFile(envPath, name);
    if (fileValue) return fileValue;
  }
  return "";
}

/** Read the ClickUp API token from the environment or a local .env file. */
export function getApiToken(): string {
  return getEnvValue("CLICKUP_API_TOKEN");
}
