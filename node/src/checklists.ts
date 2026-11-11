/**
 * Markdown checklist sections <-> ClickUp task checklists.
 *
 * A section starts at a `## Checklist` or `## Checklist: Name` heading (any
 * level from ## to ######) and runs until the next heading of the same or a
 * higher level. `- [ ] item` / `- [x] item` lines become checklist items;
 * deeper indentation nests an item under the one above it.
 */

import { httpRequest, isDict, parseJson, pySplitlines } from "./common.js";
import { extractChecklists, type Checklist, type ChecklistItem } from "./read-task.js";
import { getTask, taskQuery, type TaskDestination } from "./update-task.js";

/** One `- [ ]` item; parentIndex points at an earlier item in the same checklist. */
export interface MarkdownChecklistItem {
  name: string;
  resolved: boolean;
  parentIndex: number | null;
}

export interface MarkdownChecklist {
  name: string;
  items: MarkdownChecklistItem[];
}

export interface ChecklistSyncResult {
  checklistsCreated: number;
  itemsCreated: number;
  itemsUpdated: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const CHECKLIST_HEADING_RE = /^checklist(?:\s*:\s*(.+?))?$/i;
const ITEM_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** Pull checklist sections out of Markdown; returns the checklists and the Markdown without them. */
export function extractChecklistSections(markdown: string): [MarkdownChecklist[], string] {
  const checklists: MarkdownChecklist[] = [];
  const kept: string[] = [];
  let inFence = false;
  let section: { level: number; checklist: MarkdownChecklist; stack: Array<{ indent: number; index: number }> } | null = null;

  for (const line of pySplitlines(markdown, true)) {
    const text = line.replace(/\r?\n$/, "");
    if (FENCE_RE.test(text)) inFence = !inFence;
    const heading = inFence ? null : HEADING_RE.exec(text);

    if (heading && section && heading[1]!.length <= section.level) section = null;
    if (heading && heading[1]!.length >= 2) {
      const match = CHECKLIST_HEADING_RE.exec(heading[2]!.trim());
      if (match) {
        const checklist: MarkdownChecklist = { name: (match[1] ?? "").trim() || "Checklist", items: [] };
        checklists.push(checklist);
        section = { level: heading[1]!.length, checklist, stack: [] };
        continue;
      }
    }
    if (!section) {
      kept.push(line);
      continue;
    }

    const item = inFence ? null : ITEM_RE.exec(text);
    if (!item) continue;
    const indent = item[1]!.replace(/\t/g, "    ").length;
    while (section.stack.length && section.stack[section.stack.length - 1]!.indent >= indent) section.stack.pop();
    const index = section.checklist.items.length;
    section.checklist.items.push({
      name: item[3]!,
      resolved: item[2] !== " ",
      parentIndex: section.stack.length ? section.stack[section.stack.length - 1]!.index : null,
    });
    section.stack.push({ indent, index });
  }
  return [checklists, kept.join("")];
}

/** Render a ClickUp checklist as a `## Checklist: Name` section (parents before children). */
export function renderChecklistSection(checklist: Checklist): string {
  const lines = [`## Checklist: ${checklist.name}`, ""];
  const byId = new Set(checklist.items.map((item) => item.itemId).filter(Boolean));
  const rendered = new Set<ChecklistItem>();
  const render = (item: ChecklistItem, depth: number): void => {
    if (rendered.has(item)) return;
    rendered.add(item);
    lines.push(`${"  ".repeat(depth)}- [${item.resolved ? "x" : " "}] ${item.name}`);
    for (const child of checklist.items) {
      if (item.itemId && child.parent === item.itemId && child !== item) render(child, depth + 1);
    }
  };
  for (const item of checklist.items) {
    if (!item.parent || !byId.has(item.parent)) render(item, 0);
  }
  for (const item of checklist.items) render(item, 0);
  return `${lines.join("\n")}\n`;
}

async function sendJson(url: string, method: string, apiToken: string, data: unknown): Promise<unknown> {
  const body = await httpRequest(url, {
    method,
    headers: { Authorization: apiToken, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(data),
  });
  return body ? parseJson(body) : {};
}

function responseChecklist(payload: unknown): Record<string, unknown> {
  return isDict(payload) && isDict(payload.checklist) ? payload.checklist : {};
}

/**
 * Create missing checklists and items and update item state/nesting so ClickUp
 * matches the Markdown. Checklists and items are matched by name; nothing in
 * ClickUp is deleted.
 */
export async function syncChecklists(
  destination: TaskDestination,
  wanted: MarkdownChecklist[],
  apiToken: string,
): Promise<ChecklistSyncResult> {
  const result: ChecklistSyncResult = { checklistsCreated: 0, itemsCreated: 0, itemsUpdated: 0 };
  if (!wanted.length) return result;

  const task = await getTask(destination, apiToken);
  const existing = extractChecklists(isDict(task) ? task : {});
  const usedChecklists = new Set<string>();

  for (const checklist of wanted) {
    let target = existing.find((candidate) => candidate.name === checklist.name && !usedChecklists.has(candidate.checklistId));
    if (!target) {
      const created = responseChecklist(
        await sendJson(
          `https://api.clickup.com/api/v2/task/${destination.taskId}/checklist${taskQuery(destination)}`,
          "POST",
          apiToken,
          { name: checklist.name },
        ),
      );
      const id = typeof created.id === "string" ? created.id : "";
      if (!id) throw new Error(`ClickUp did not return an ID for checklist ${checklist.name}`);
      target = { checklistId: id, name: checklist.name, items: [] };
      result.checklistsCreated++;
    }
    usedChecklists.add(target.checklistId);

    const itemsUrl = `https://api.clickup.com/api/v2/checklist/${target.checklistId}/checklist_item`;
    const known = new Set(target.items.map((item) => item.itemId));
    const usedItems = new Set<string>();
    const ids: string[] = [];

    for (const item of checklist.items) {
      const parentId = item.parentIndex === null ? null : (ids[item.parentIndex] ?? null);
      const match = target.items.find((candidate) => candidate.name === item.name && !usedItems.has(candidate.itemId));
      if (match) {
        usedItems.add(match.itemId);
        ids.push(match.itemId);
        if (match.resolved !== item.resolved || (match.parent ?? null) !== parentId) {
          await sendJson(`${itemsUrl}/${match.itemId}`, "PUT", apiToken, { resolved: item.resolved, parent: parentId });
          result.itemsUpdated++;
        }
        continue;
      }

      const created = responseChecklist(await sendJson(itemsUrl, "POST", apiToken, { name: item.name }));
      const items = Array.isArray(created.items) ? created.items.filter(isDict) : [];
      const fresh = items.find((candidate) => candidate.name === item.name && typeof candidate.id === "string" && !known.has(candidate.id));
      const id = fresh && typeof fresh.id === "string" ? fresh.id : "";
      if (!id) throw new Error(`ClickUp did not return an ID for checklist item ${item.name}`);
      known.add(id);
      usedItems.add(id);
      ids.push(id);
      result.itemsCreated++;
      if (item.resolved || parentId) {
        await sendJson(`${itemsUrl}/${id}`, "PUT", apiToken, { resolved: item.resolved, parent: parentId });
      }
    }
  }
  return result;
}
