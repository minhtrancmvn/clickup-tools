import { describe, expect, it } from "vitest";

import { BufferedOutput, parseCli, type CliSpec } from "../src/common.js";
import { run as runReadTask } from "../src/read-task.js";
import { run as runSendTelegram } from "../src/send-telegram.js";
import { run as runUpdatePage } from "../src/update-page.js";

const PARENT = { prog: "tool", usage: "usage: tool [-h] {sub} ...\n" };

const SPEC: CliSpec = {
  prog: "tool sub",
  usage: "usage: tool sub [-h]\n",
  help: "HELP\n",
  maxPositionals: 1,
  options: {
    help: { type: "boolean", short: "h" },
    "task-id": { type: "string" },
    "no-open": { type: "boolean" },
    "no-rich-links": { type: "boolean" },
  },
};

describe("parseCli (argparse semantics)", () => {
  it("expands_unique_long_option_prefixes", () => {
    const parsed = parseCli(SPEC, ["--task=OOLE-1", "--no-o", "file"], new BufferedOutput());
    expect(parsed).toMatchObject({
      values: { "task-id": "OOLE-1", "no-open": true },
      positionals: ["file"],
      optionOrder: ["task-id", "no-open"],
      extras: [],
    });
  });

  it("rejects_ambiguous_prefixes_listing_candidates_in_declaration_order", () => {
    const io = new BufferedOutput();
    expect(parseCli(SPEC, ["--no"], io)).toBe(2);
    expect(io.err).toBe("usage: tool sub [-h]\ntool sub: error: ambiguous option: --no could match --no-open, --no-rich-links\n");
  });

  it("accepts_negative_numbers_and_spaced_dash_strings_as_values", () => {
    expect(parseCli(SPEC, ["--task-id", "-100123"], new BufferedOutput())).toMatchObject({ values: { "task-id": "-100123" } });
    expect(parseCli(SPEC, ["--task-id", "- note"], new BufferedOutput())).toMatchObject({ values: { "task-id": "- note" } });
    expect(parseCli(SPEC, ["--task-id=--x"], new BufferedOutput())).toMatchObject({ values: { "task-id": "--x" } });
  });

  it("rejects_option_like_values_and_boolean_inline_values", () => {
    const missing = new BufferedOutput();
    expect(parseCli(SPEC, ["--task-id", "--no-open"], missing)).toBe(2);
    expect(missing.err).toContain("argument --task-id: expected one argument");

    const inline = new BufferedOutput();
    expect(parseCli(SPEC, ["--no-open=1"], inline)).toBe(2);
    expect(inline.err).toContain("argument --no-open: ignored explicit argument '1'");
  });

  it("reports_all_extras_in_argv_order_via_parent_after_validation", () => {
    const spec = { ...SPEC, parent: PARENT };
    const io = new BufferedOutput();
    expect(parseCli(spec, ["a", "--bogus", "b"], io, { extras: ["-x"] })).toBe(2);
    expect(io.err).toBe("usage: tool [-h] {sub} ...\ntool: error: unrecognized arguments: -x --bogus b\n");

    const validated = new BufferedOutput();
    expect(parseCli(spec, ["--bogus"], validated, { validate: () => "the following arguments are required: X" })).toBe(2);
    expect(validated.err).toBe("usage: tool sub [-h]\ntool sub: error: the following arguments are required: X\n");
  });
});

describe("command-level argparse parity", () => {
  it("send_telegram_reports_subcommand_extras_with_top_level_usage", async () => {
    const io = new BufferedOutput();
    expect(await runSendTelegram(["-x", "send", "y", "--zz"], io)).toBe(2);
    expect(io.err).toBe(
      "usage: clickup-send-telegram [-h] {chats,send} ...\nclickup-send-telegram: error: unrecognized arguments: -x --zz\n",
    );
  });

  it("send_telegram_required_tasks_error_wins_over_extras", async () => {
    const io = new BufferedOutput();
    expect(await runSendTelegram(["send", "--bogus"], io)).toBe(2);
    expect(io.err).toContain("clickup-send-telegram send: error: the following arguments are required: TASK_OR_URL");
  });

  it("update_page_exclusion_error_names_the_later_flag", async () => {
    const io = new BufferedOutput();
    expect(await runUpdatePage(["x.md", "--prepend", "--app"], io)).toBe(2);
    expect(io.err).toContain("argument --append: not allowed with argument --prepend");
  });

  it("read_task_comment_limit_error_wins_over_extras", async () => {
    const io = new BufferedOutput();
    expect(await runReadTask(["--bogus", "--comment-limit", "0"], io)).toBe(2);
    expect(io.err).toContain("argument --comment-limit: comment limit must be between 1 and 100");
  });
});
