import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { extractChecklistSections, renderChecklistSection, syncChecklists } from "../src/checklists.js";
import { BufferedOutput } from "../src/common.js";
import { runPullTask } from "../src/pull.js";
import { parseDocUrl, readCreatePageTarget, run as runUpdatePage, setFrontMatterValues } from "../src/update-page.js";
import { parseListId, run as runUpdateTask, taskDestination } from "../src/update-task.js";
import { bodyJson, jsonResponse, stubFetch, tempDir, type FetchCall } from "./helpers.js";

function writeFile(name: string, content: string): string {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, content);
  return file;
}

const describeCalls = (calls: FetchCall[]) => calls.map((call) => `${call.method} ${call.url}`);

describe("front matter write-back", () => {
  it("adds_replaces_and_creates_front_matter", () => {
    const withBlock = writeFile("a.md", "---\nclickup-doc: x\nclickup-page: old\n---\n# T\n");
    setFrontMatterValues(withBlock, [["clickup-page", "new"], ["extra", "1"]]);
    expect(fs.readFileSync(withBlock, "utf8")).toBe("---\nclickup-doc: x\nclickup-page: new\nextra: 1\n---\n# T\n");

    const bare = writeFile("b.md", "# T\n\nBody\n");
    setFrontMatterValues(bare, [["clickup-task-id", "86x"]]);
    expect(fs.readFileSync(bare, "utf8")).toBe("---\nclickup-task-id: 86x\n---\n# T\n\nBody\n");

    const crlf = writeFile("c.md", "---\r\nclickup-list: 9\r\n---\r\n# T\r\n");
    setFrontMatterValues(crlf, [["clickup-task-id", "86x"]]);
    expect(fs.readFileSync(crlf, "utf8")).toBe("---\r\nclickup-list: 9\r\nclickup-task-id: 86x\r\n---\r\n# T\r\n");
  });

  it("parses_doc_and_list_references", () => {
    expect(parseDocUrl("https://app.clickup.com/123/v/dc/doc-1")).toEqual(["123", "doc-1"]);
    expect(parseDocUrl("https://app.clickup.com/123/docs/doc-1/page-9")).toEqual(["123", "doc-1"]);
    expect(() => parseDocUrl("https://example.com")).toThrow("Cannot parse ClickUp Doc URL");
    expect(parseListId("901801482831")).toBe("901801482831");
    expect(parseListId("https://app.clickup.com/9018/v/li/901801482831")).toBe("901801482831");
    expect(parseListId("https://app.clickup.com/9018/v/l/6-901801482831-1")).toBe("901801482831");
    expect(() => parseListId("Sprint 5")).toThrow("Cannot parse ClickUp List");
  });

  it("only_creates_pages_when_clickup_page_is_missing", () => {
    expect(readCreatePageTarget(writeFile("p.md", "---\nclickup-doc: https://app.clickup.com/1/v/dc/d\n---\n"))).toEqual({
      workspaceId: "1",
      docId: "d",
      parentPageId: "",
    });
    expect(
      readCreatePageTarget(
        writeFile("q.md", "---\nclickup-doc: https://app.clickup.com/1/v/dc/d\nclickup-parent-page: https://app.clickup.com/1/v/dc/d/p7\n---\n"),
      ),
    ).toMatchObject({ parentPageId: "p7" });
    expect(readCreatePageTarget(writeFile("r.md", "---\nclickup-doc: https://app.clickup.com/1/v/dc/d\nclickup-page: https://app.clickup.com/1/v/dc/d/p\n---\n"))).toBeNull();
  });
});

describe("update-page: create a page from clickup-doc", () => {
  it("creates_the_page_records_it_and_updates_on_the_next_run", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const file = writeFile(
      "page.md",
      "---\nclickup-doc: https://app.clickup.com/123/v/dc/doc-1\nclickup-parent-page: p0\nsubtitle: Draft\n---\n# New page\n\nBody\n",
    );
    const created = stubFetch(() => jsonResponse({ id: "p-new", doc_id: "doc-1" }, 201));
    const io = new BufferedOutput();

    expect(await runUpdatePage([file, "--no-open", "--no-rich-links"], io)).toBe(0);

    expect(describeCalls(created)).toEqual(["POST https://api.clickup.com/api/v3/workspaces/123/docs/doc-1/pages"]);
    expect(bodyJson(created[0]!)).toEqual({ name: "New page", content: "Body\n", content_format: "text/md", sub_title: "Draft", parent_page_id: "p0" });
    expect(fs.readFileSync(file, "utf8")).toContain("clickup-page: https://app.clickup.com/123/v/dc/doc-1/p-new\n---\n# New page");
    expect(io.out).toContain("Page created");

    const updated = stubFetch(() => new Response(""));
    expect(await runUpdatePage([file, "--no-open", "--no-rich-links"], new BufferedOutput())).toBe(0);
    expect(describeCalls(updated)).toEqual(["PUT https://api.clickup.com/api/v3/workspaces/123/docs/doc-1/pages/p-new"]);
  });

  it("requires_a_heading_before_creating", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const file = writeFile("page.md", "---\nclickup-doc: https://app.clickup.com/123/v/dc/doc-1\n---\nNo heading\n");
    const calls = stubFetch(() => jsonResponse({ id: "x" }));
    const io = new BufferedOutput();

    expect(await runUpdatePage([file, "--no-open", "--no-rich-links"], io)).toBe(1);
    expect(io.err).toContain("A new page needs a name");
    expect(calls).toHaveLength(0);
  });
});

describe("update-task: create a task from clickup-list", () => {
  it("creates_records_the_custom_id_then_updates_the_new_task", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const file = writeFile("task.md", "---\nclickup-list: https://app.clickup.com/9018/v/li/900\npriority: high\n---\n# New task\n\nBody\n");
    const calls = stubFetch((call) =>
      call.method === "POST" ? jsonResponse({ id: "86new", custom_id: "OOLE-9", team_id: "9018" }) : jsonResponse({}),
    );
    const io = new BufferedOutput();

    expect(await runUpdateTask([file, "--no-rich-links"], io)).toBe(0);

    expect(describeCalls(calls)).toEqual(["POST https://api.clickup.com/api/v2/list/900/task", "PUT https://api.clickup.com/api/v2/task/86new"]);
    expect(bodyJson(calls[0]!)).toEqual({ name: "New task" });
    expect(bodyJson(calls[1]!)).toEqual({ markdown_content: "Body\n", name: "New task", priority: 2 });
    expect(fs.readFileSync(file, "utf8")).toContain("clickup-task-id: OOLE-9\nclickup-team-id: 9018\n---");
    expect(io.out).toContain("Created     : task OOLE-9 in List 900");
  });

  it("resolves_a_custom_parent_and_uses_the_internal_id_without_custom_ids", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    vi.stubEnv("CLICKUP_TEAM_ID", "9018");
    const file = writeFile("sub.md", "---\nclickup-list: 900\nclickup-parent-task: OOLE-1\n---\n# Sub\n");
    const calls = stubFetch((call) => {
      if (call.method === "GET") return jsonResponse({ id: "86par" });
      if (call.method === "POST") return jsonResponse({ id: "86sub" });
      return jsonResponse({});
    });

    expect(await runUpdateTask([file, "--no-rich-links"], new BufferedOutput())).toBe(0);

    expect(describeCalls(calls)).toEqual([
      "GET https://api.clickup.com/api/v2/task/OOLE-1?custom_task_ids=true&team_id=9018",
      "POST https://api.clickup.com/api/v2/list/900/task",
      "PUT https://api.clickup.com/api/v2/task/86sub",
    ]);
    expect(bodyJson(calls[1]!)).toEqual({ name: "Sub", parent: "86par" });
    expect(fs.readFileSync(file, "utf8")).toContain("clickup-task-id: 86sub\n---");
  });

  it("validates_before_creating_anything", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const calls = stubFetch(() => jsonResponse({ id: "x" }));
    for (const [content, message] of [
      ["---\nclickup-list: 900\n---\nNo heading\n", "A new task needs a name"],
      ["---\nclickup-list: 900\npoints: many\n---\n# T\n", "points must be a number"],
      ["---\nclickup-list: 900\n---\n# T\n\n![x](missing.png)\n", "Referenced attachment file not found"],
    ] as const) {
      const io = new BufferedOutput();
      expect(await runUpdateTask([writeFile("bad.md", content)], io)).toBe(1);
      expect(io.err).toContain(message);
    }
    expect(calls).toHaveLength(0);
  });

  it("reports_the_new_id_when_it_cannot_be_saved", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const file = writeFile("ro.md", "---\nclickup-list: 900\n---\n# T\n");
    fs.chmodSync(file, 0o444);
    stubFetch(() => jsonResponse({ id: "86ro" }));
    const io = new BufferedOutput();

    expect(await runUpdateTask([file], io)).toBe(1);
    expect(io.err).toContain("Task 86ro was created, but saving clickup-task-id");
  });
});

describe("checklist sections", () => {
  it("extracts_named_nested_sections_and_removes_them", () => {
    const [checklists, rest] = extractChecklistSections(
      [
        "Intro",
        "",
        "## Checklist: QA",
        "- [x] Smoke test",
        "  - [ ] iOS",
        "  - [X] Android",
        "- [ ] Regression",
        "not an item",
        "",
        "## Notes",
        "```",
        "## Checklist: inside code",
        "- [ ] ignored",
        "```",
        "### Checklist",
        "* [ ] Default name",
        "",
      ].join("\n"),
    );

    expect(checklists).toEqual([
      {
        name: "QA",
        items: [
          { name: "Smoke test", resolved: true, parentIndex: null },
          { name: "iOS", resolved: false, parentIndex: 0 },
          { name: "Android", resolved: true, parentIndex: 0 },
          { name: "Regression", resolved: false, parentIndex: null },
        ],
      },
      { name: "Checklist", items: [{ name: "Default name", resolved: false, parentIndex: null }] },
    ]);
    expect(rest).toBe("Intro\n\n## Notes\n```\n## Checklist: inside code\n- [ ] ignored\n```\n");
  });

  it("renders_sections_that_parse_back_to_the_same_checklist", () => {
    const rendered = renderChecklistSection({
      checklistId: "c",
      name: "QA",
      items: [
        { itemId: "2", name: "child", resolved: true, parent: "1", children: [] },
        { itemId: "1", name: "parent", resolved: false, parent: null, children: ["2"] },
      ],
    });
    expect(rendered).toBe("## Checklist: QA\n\n- [ ] parent\n  - [x] child\n");
    expect(extractChecklistSections(rendered)[0]).toEqual([
      {
        name: "QA",
        items: [
          { name: "parent", resolved: false, parentIndex: null },
          { name: "child", resolved: true, parentIndex: 0 },
        ],
      },
    ]);
  });

  it("syncs_by_name_creating_and_updating_without_deleting", async () => {
    const task = {
      id: "86t",
      checklists: [
        {
          id: "cl1",
          name: "QA",
          items: [
            { id: "a1", name: "a", resolved: false, parent: null },
            { id: "b1", name: "b", resolved: true, parent: null },
            { id: "z1", name: "only in ClickUp", resolved: false, parent: null },
          ],
        },
      ],
    };
    const calls = stubFetch((call) => {
      if (call.method === "GET") return jsonResponse(task);
      if (call.url.endsWith("/task/86t/checklist")) return jsonResponse({ checklist: { id: "cl2", items: [] } });
      if (call.method === "POST" && call.url.includes("/checklist/cl1/")) {
        return jsonResponse({ checklist: { id: "cl1", items: [...task.checklists[0]!.items, { id: "c1", name: "c" }] } });
      }
      if (call.method === "POST") return jsonResponse({ checklist: { id: "cl2", items: [{ id: "s1", name: "ship" }] } });
      return jsonResponse({});
    });
    const [wanted] = extractChecklistSections("## Checklist: QA\n- [x] a\n  - [ ] c\n- [ ] b\n## Checklist: Release\n- [ ] ship\n");

    const result = await syncChecklists(taskDestination("86t"), wanted, "pk");

    expect(result).toEqual({ checklistsCreated: 1, itemsCreated: 2, itemsUpdated: 2 });
    expect(describeCalls(calls)).toEqual([
      "GET https://api.clickup.com/api/v2/task/86t",
      "PUT https://api.clickup.com/api/v2/checklist/cl1/checklist_item/a1",
      "POST https://api.clickup.com/api/v2/checklist/cl1/checklist_item",
      "PUT https://api.clickup.com/api/v2/checklist/cl1/checklist_item/c1",
      "PUT https://api.clickup.com/api/v2/checklist/cl1/checklist_item/b1",
      "POST https://api.clickup.com/api/v2/task/86t/checklist",
      "POST https://api.clickup.com/api/v2/checklist/cl2/checklist_item",
    ]);
    expect(bodyJson(calls[1]!)).toEqual({ resolved: true, parent: null });
    expect(bodyJson(calls[2]!)).toEqual({ name: "c" });
    expect(bodyJson(calls[3]!)).toEqual({ resolved: false, parent: "a1" });
    expect(bodyJson(calls[4]!)).toEqual({ resolved: false, parent: null });
    expect(bodyJson(calls[5]!)).toEqual({ name: "Release" });
  });

  it("update_task_keeps_sections_out_of_the_description_and_syncs_them", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const file = writeFile("t.md", "---\nclickup-task-id: 86t\n---\n# T\n\nBody\n\n## Checklist: QA\n- [ ] a\n");
    const calls = stubFetch((call) => {
      if (call.method === "GET") return jsonResponse({ id: "86t", checklists: [] });
      if (call.url.endsWith("/checklist")) return jsonResponse({ checklist: { id: "cl1" } });
      if (call.url.endsWith("/checklist_item")) return jsonResponse({ checklist: { items: [{ id: "a1", name: "a" }] } });
      return jsonResponse({});
    });
    const io = new BufferedOutput();

    expect(await runUpdateTask([file, "--no-rich-links"], io)).toBe(0);

    expect(bodyJson(calls[0]!)).toEqual({ markdown_content: "Body\n", name: "T" });
    expect(io.out).toContain("Checklist   : QA (1 item)");
    expect(io.out).toContain("Checklists synced (checklists created=1, items created=1, items updated=0)");
  });

  it("pulled_task_checklists_round_trip_with_no_changes", async () => {
    vi.stubEnv("CLICKUP_API_TOKEN", "pk_test");
    const task = {
      id: "86t",
      name: "T",
      markdown_description: "Body",
      checklists: [
        {
          id: "cl1",
          name: "QA",
          items: [
            { id: "a1", name: "a", resolved: true, parent: null },
            { id: "b1", name: "b", resolved: false, parent: "a1" },
          ],
        },
      ],
    };
    stubFetch(() => jsonResponse(task));
    const file = path.join(tempDir(), "t.md");
    expect(await runPullTask(["86t", "-o", file], new BufferedOutput())).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("---\nclickup-task-id: 86t\n---\n\n# T\n\nBody\n\n## Checklist: QA\n\n- [x] a\n  - [ ] b\n");

    const calls = stubFetch((call) => (call.method === "GET" ? jsonResponse(task) : jsonResponse({})));
    expect(await runUpdateTask([file, "--no-rich-links"], new BufferedOutput())).toBe(0);
    expect(describeCalls(calls)).toEqual(["PUT https://api.clickup.com/api/v2/task/86t", "GET https://api.clickup.com/api/v2/task/86t"]);
    expect(bodyJson(calls[0]!)).toMatchObject({ markdown_content: "Body\n" });
  });
});
