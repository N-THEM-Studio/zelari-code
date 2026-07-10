/**
 * core-parseTextToolCalls.test.ts
 *
 * The agent system prompt documents a `---TOOLS---[json]---END---` fallback for
 * models that don't emit native tool_calls, but nothing parsed it — so when a
 * model followed the instruction (observed in a council fix turn), its edits
 * were emitted as text and silently dropped ("described edits it never made").
 * parseTextToolCalls extracts those calls so the harness can execute them.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeTextToolArgs,
  parseTextToolCalls,
} from "@zelari/core/harness";

describe("parseTextToolCalls", () => {
  it("parses a valid ---TOOLS--- block into name/args pairs", () => {
    const text = `Here is my fix.
---TOOLS---
[{"name":"edit_file","args":{"path":"index.html","oldString":"a","newString":"b"}}]
---END---`;
    expect(parseTextToolCalls(text)).toEqual([
      {
        name: "edit_file",
        args: { path: "index.html", oldString: "a", newString: "b" },
      },
    ]);
  });

  it("parses multiple tool calls in one block", () => {
    const text = `---TOOLS---
[{"name":"read_file","args":{"path":"a"}},{"name":"edit_file","args":{"path":"a","oldString":"x","newString":"y"}}]
---END---`;
    const out = parseTextToolCalls(text);
    expect(out).toHaveLength(2);
    expect(out[0]?.name).toBe("read_file");
    expect(out[1]?.name).toBe("edit_file");
  });

  it("returns [] when there is no block", () => {
    expect(parseTextToolCalls("just a normal answer with no tools")).toEqual(
      [],
    );
  });

  it("returns [] on malformed JSON", () => {
    expect(parseTextToolCalls("---TOOLS---\n[not json]\n---END---")).toEqual(
      [],
    );
  });

  it("defaults missing/invalid args to an empty object", () => {
    const text = '---TOOLS---\n[{"name":"list_files"}]\n---END---';
    expect(parseTextToolCalls(text)).toEqual([
      { name: "list_files", args: {} },
    ]);
  });

  it("skips entries without a string name", () => {
    const text =
      '---TOOLS---\n[{"args":{"x":1}},{"name":"ok","args":{}}]\n---END---';
    expect(parseTextToolCalls(text)).toEqual([{ name: "ok", args: {} }]);
  });

  it("merges multiple stacked JSON arrays (common model mistake)", () => {
    // Observed in live plan-mode: one array per updateTask instead of one array.
    const text = `---TOOLS---
[{"name":"updateTask","args":{"taskId":"a","status":"done"}}]
[{"name":"updateTask","args":{"taskId":"b","status":"in_progress"}}]
[{"name":"updateTask","args":{"taskId":"c","status":"pending"}}]
---END---`;
    const out = parseTextToolCalls(text);
    expect(out).toHaveLength(3);
    expect(out.map((t) => t.args.taskId)).toEqual(["a", "b", "c"]);
  });

  it("recovers lightly over-escaped quotes", () => {
    const text =
      '---TOOLS---\n[{\\"name\\":\\"list_files\\",\\"args\\":{}}]\n---END---';
    const out = parseTextToolCalls(text);
    expect(out).toEqual([{ name: "list_files", args: {} }]);
  });

  it("strips markdown fences around the JSON body", () => {
    const text = `---TOOLS---
\`\`\`json
[{"name":"read_file","args":{"path":"x.ts"}}]
\`\`\`
---END---`;
    expect(parseTextToolCalls(text)).toEqual([
      { name: "read_file", args: { path: "x.ts" } },
    ]);
  });
});

describe("normalizeTextToolArgs", () => {
  it("maps snake_case edit_file keys", () => {
    expect(
      normalizeTextToolArgs("edit_file", {
        path: "a.html",
        old_string: "x",
        new_string: "y",
        replace_all: true,
      }),
    ).toMatchObject({
      oldString: "x",
      newString: "y",
      replaceAll: true,
    });
  });
});
