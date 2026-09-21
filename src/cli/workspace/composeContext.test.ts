/**
 * composeContext.test.ts — t162: frozen eval baselines must never reach the
 * "Task scope (this request)" section (Targets / Keywords).
 *
 * Observed bug (Desktop context-update panel): the composer proposed
 * `registry.ts` / `folderTrust.ts` + the keywords `compositor-only,
 * inline-js<=5120b` as CURRENT scope. Those strings only exist inside
 * `eval/results/edit-bench/baseline-wt2/` — a frozen baseline copied from an
 * old worktree. Whatever quotes that baseline into the request (a
 * context-update draft, a plan task, a pasted dump) must not turn fossils
 * into scope.
 *
 * Contract pinned here:
 *   1. a request line citing `eval/results/**` contributes NOTHING to the
 *      composer's scope — no Targets, no Keywords (directory-level exclusion:
 *      every nested baseline, not just baseline-wt2);
 *   2. a control path OUTSIDE eval/results still lands in Targets exactly as
 *      before, and non-fossil request text still yields its keywords.
 *
 * The request lines are *derived from the fossil file* on purpose: the
 * baseline is what feeds them, so the test keeps the real chain
 * (fossil file content → scope input → composed Task scope).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  composeProjectContext,
  FROZEN_EVAL_DIR_PREFIX,
  stripFrozenEvalScopeLines,
} from "./composeContext.js";

/** Directory-level prefix of every frozen eval baseline (t162). */
const FOSSIL_DIR = "eval/results/edit-bench/baseline-wt2";
/** Fossil copy of a product file — exists ONLY in the frozen baseline. */
const FOSSIL_FILE = `${FOSSIL_DIR}/packages/core/src/core/tools/registry.ts`;
/** Fossil copy of the old worktree's plan task files (keyword carriers). */
const FOSSIL_PLAN_DUMP = `${FOSSIL_DIR}/.zelari/plan-dump.md`;
/** Real current-workspace file — the control that MUST stay in scope. */
const CONTROL_FILE = "src/cli/workspace/composeContext.ts";
/** A second control, to prove multi-target matching is untouched. */
const CONTROL_FILE_2 = "src/cli/workspace/workspaceSummary.ts";

/** Content of the frozen baseline (the "fossil" strings, verbatim). */
const FOSSIL_CONTENT = [
  "targets: packages/core/src/core/tools/registry.ts, folderTrust.ts",
  "keywords: compositor-only, inline-js<=5120b, motion",
].join("\n");

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

/**
 * Fixture tree: a frozen eval baseline (with a nested vault dump), two real
 * product files, and a plan so `buildPlanSummary` renders the scope section.
 */
function seedFixture(root: string): void {
  writeFile(root, FOSSIL_FILE, FOSSIL_CONTENT);
  writeFile(root, FOSSIL_PLAN_DUMP, FOSSIL_CONTENT);
  writeFile(root, CONTROL_FILE, "// current scope\nexport const x = 1;\n");
  writeFile(root, CONTROL_FILE_2, "// current scope too\n");
  writeFile(
    root,
    ".zelari/plan.json",
    JSON.stringify({
      schemaVersion: 1,
      counter: 1,
      tasks: [
        {
          id: "t162",
          name: `Escludere i baseline congelati dallo scope matcher in ${CONTROL_FILE}`,
          status: "pending",
          priority: "high",
        },
      ],
    }),
  );
}

/** The scope section only — the plan/design blocks legitimately cite paths. */
function scopeBlock(workspaceContext: string): string {
  const start = workspaceContext.indexOf("## Task scope (this request)");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = workspaceContext.slice(start);
  const end = rest.indexOf("_Deliver only what is in scope");
  return end >= 0 ? rest.slice(0, end) : rest;
}

function targetsLine(scope: string): string {
  return scope.split("\n").find((l) => l.startsWith("Targets:")) ?? "";
}

function keywordsLine(scope: string): string {
  return scope.split("\n").find((l) => l.startsWith("Keywords:")) ?? "";
}

describe("composeProjectContext — frozen eval baselines never become scope (t162)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "compose-ctx-"));
    seedFixture(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a request line quoting the baseline contributes no Targets and no Keywords", () => {
    // The context-update draft quotes the fossil file, verbatim.
    const fossilLines = readFileSync(join(dir, FOSSIL_FILE), "utf8").trim();
    const request = [
      "Aggiorna il context composer con lo stato trovato in",
      `${FOSSIL_FILE}`,
      fossilLines.split("\n")[1]!, // "keywords: compositor-only, inline-js<=5120b, motion"
      `Controllo: ${CONTROL_FILE} e ${CONTROL_FILE_2}`,
    ].join("\n");

    const { workspaceContext } = composeProjectContext({
      mode: "kraken",
      cwd: dir,
      userMessage: request,
    });
    const scope = scopeBlock(workspaceContext);

    // Fossil: no path, no keyword, no baseline directory.
    expect(scope).not.toContain("eval/results");
    expect(scope).not.toContain("baseline-wt2");
    expect(scope).not.toContain("registry.ts");
    expect(scope).not.toContain("folderTrust.ts");
    expect(keywordsLine(scope)).not.toContain("compositor");
    expect(keywordsLine(scope)).not.toContain("inline-js");
    expect(keywordsLine(scope)).not.toContain("motion");

    // Control: the real current-scope files still match.
    expect(targetsLine(scope)).toContain(CONTROL_FILE);
    expect(targetsLine(scope)).toContain(CONTROL_FILE_2);
  });

  it("the baseline directory itself (no filename) contributes nothing", () => {
    const request = [
      `Contesto congelato in ${FOSSIL_DIR}: compositor-only, motion`,
      `Controllo: ${CONTROL_FILE}`,
    ].join("\n");

    const { workspaceContext } = composeProjectContext({
      mode: "kraken",
      cwd: dir,
      userMessage: request,
    });
    const scope = scopeBlock(workspaceContext);

    expect(scope).not.toContain("eval/results");
    expect(keywordsLine(scope)).not.toContain("compositor");
    expect(keywordsLine(scope)).not.toContain("motion");
    expect(targetsLine(scope)).toContain(CONTROL_FILE);
  });

  it("non-frozen request text is matched exactly as before (targets + keywords)", () => {
    const request = [
      `Animate ${CONTROL_FILE_2} with compositor-only motion`,
      `and touch ${CONTROL_FILE}`,
    ].join("\n");

    const { workspaceContext } = composeProjectContext({
      mode: "kraken",
      cwd: dir,
      userMessage: request,
    });
    const scope = scopeBlock(workspaceContext);

    expect(targetsLine(scope)).toContain(CONTROL_FILE);
    expect(targetsLine(scope)).toContain(CONTROL_FILE_2);
    expect(keywordsLine(scope)).toContain("motion");
    expect(keywordsLine(scope)).toContain("compositor");
  });

  it("no request → no scope section at all (fresh/degenerate input unchanged)", () => {
    const { workspaceContext } = composeProjectContext({ mode: "kraken", cwd: dir });
    expect(workspaceContext).not.toContain("## Task scope (this request)");
  });
});

describe("stripFrozenEvalScopeLines", () => {
  it("drops the citing line AND the quoted dump that follows it, until a blank line", () => {
    const input = [
      "keep me",
      `drop ${FOSSIL_FILE} — compositor-only, motion`,
      "keywords: compositor-only, inline-js<=5120b",
      "",
      "keep me too",
    ].join("\n");
    expect(stripFrozenEvalScopeLines(input)).toBe("keep me\n\nkeep me too");
  });

  it("a line citing a real (non-frozen) path closes the block and is kept", () => {
    const input = [
      `Contesto congelato in ${FOSSIL_DIR} — compositor-only, motion`,
      "Controllo: src/cli/workspace/composeContext.ts",
    ].join("\n");
    expect(stripFrozenEvalScopeLines(input)).toBe(
      "Controllo: src/cli/workspace/composeContext.ts",
    );
  });

  it("a quoted block running to the end of the input leaves only the preamble", () => {
    const input = [
      "Aggiorna il context composer",
      FOSSIL_FILE,
      "reason: parity with the frozen baseline",
    ].join("\n");
    expect(stripFrozenEvalScopeLines(input)).toBe("Aggiorna il context composer");
  });

  it("is directory-level: any nested baseline under eval/results/ is dropped", () => {
    for (const p of [
      "eval/results/edit-bench/baseline-wt2/a/b.ts",
      "eval/results/other-run/plan.json",
      "eval/results",
      "./eval/results/x.md",
      "Z:/repo/eval/results/edit-bench/baseline-wt2/x.ts",
    ]) {
      expect(stripFrozenEvalScopeLines(`line with ${p} inside`)).toBe("");
    }
  });

  it("handles Windows separators and case variants", () => {
    expect(stripFrozenEvalScopeLines("x eval\\results\\a\\b.ts")).toBe("");
    expect(stripFrozenEvalScopeLines("x EVAL/RESULTS/a.ts")).toBe("");
  });

  it("returns the SAME string (identity) when nothing is frozen", () => {
    const clean = `touch ${CONTROL_FILE} and ${CONTROL_FILE_2}\nsecond line`;
    expect(stripFrozenEvalScopeLines(clean)).toBe(clean);
    expect(stripFrozenEvalScopeLines("")).toBe("");
  });

  it("does not mistake lookalike names for the frozen directory", () => {
    const keep = [
      "src/eval/results-notes.md",
      "docs/eval/results.md",
      "tools/eval/runEditBench.ts",
    ].join("\n");
    expect(stripFrozenEvalScopeLines(keep)).toBe(keep);
  });

  it("exposes the directory-level prefix used by the exclusion", () => {
    expect(FROZEN_EVAL_DIR_PREFIX).toBe("eval/results");
  });
});
