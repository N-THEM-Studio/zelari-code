/**
 * composeProjectContext — single pipeline for agent / council / zelari / headless.
 *
 * Separates product truth (tree, package.json) from design vault ops (plan task
 * list) and never mislabels plan text as "RAG". Caps each section so council
 * design dumps cannot saturate the system prompt.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envNumber } from "../utils/envNumber.js";
import { loadProjectInstructions } from "./projectInstructions.js";
import { resolveWorkspaceRoot } from "./paths.js";
import {
  buildPlanSummary,
  buildWorkspaceSummary,
  buildZelariReadHint,
  EPISTEMIC_BANNER,
} from "./workspaceSummary.js";
import { buildLessonsSummary } from "./buildLessonsSummary.js";

/** Dispatch mode for context composition. `agent` kept as legacy alias of `kraken`. */
export type ComposeMode = "kraken" | "council" | "zelari" | "agent";

export interface ComposeProjectContextInput {
  mode: ComposeMode;
  cwd?: string;
  userMessage?: string;
  /** Real memory/RAG only — never plan text. */
  memoryHits?: string;
  /**
   * Durable state materialization (verified accumulation). Merged into
   * ragContext as a separate block — never into stable system prefix.
   */
  durableState?: string;
  /** Compact history block (council). */
  historySnippet?: string;
  /** Include lessons.jsonl recall (council/zelari default on). */
  includeLessons?: boolean;
  /**
   * When true (default for council/zelari/agent when state enabled), try to load
   * HEAD materialize from `.zelari/state/` if `durableState` was not provided.
   * Prefer async `loadDurableContext()` at call sites and pass `durableState`
   * to avoid the sync fallback.
   */
  includeDurableState?: boolean;
}

export interface ComposedProjectContext {
  /** Filtered AGENTS/CLAUDE body (may be empty). */
  projectInstructions: string;
  /**
   * Product truth + epistemic banner + plan ops + optional design index,
   * lessons, history. Ready for `workspaceContext`.
   */
  workspaceContext: string;
  /**
   * ONLY memory / real retrieval + optional durable state. Plan must never appear here.
   */
  ragContext: string;
  /** Human-readable notes for TUI (caps hit, vault detected, …). */
  warnings: string[];
}

function cap(text: string, max: number, label: string): { text: string; truncated: boolean } {
  if (!text || text.length <= max) return { text: text || "", truncated: false };
  return {
    text:
      text.slice(0, max) +
      `\n\n… [truncated ${label}; ${text.length} chars → use tools to read full files]`,
    truncated: true,
  };
}

function buildDesignIndex(projectRoot: string, maxChars: number): string {
  const root = resolveWorkspaceRoot(projectRoot);
  if (!existsSync(root)) return "";
  const lines: string[] = [
    "# Design vault index (.zelari/) — HYPOTHESES only",
    "Full design docs are NOT product source of truth. Open with list_files / read_file / searchDocuments if needed.",
  ];
  const docsDir = join(root, "docs");
  if (existsSync(docsDir)) {
    try {
      const docs = readdirSync(docsDir)
        .filter((n) => n.endsWith(".md"))
        .slice(0, 12);
      if (docs.length > 0) {
        lines.push("", "## docs/ (titles only)");
        for (const d of docs) lines.push(`- .zelari/docs/${d}`);
        if (readdirSync(docsDir).filter((n) => n.endsWith(".md")).length > 12) {
          lines.push("- … (more under .zelari/docs/)");
        }
      }
    } catch {
      /* ignore */
    }
  }
  for (const name of ["risks.md", "plan.json", "nfr-spec.json"] as const) {
    if (existsSync(join(root, name))) {
      lines.push(`- .zelari/${name} present`);
    }
  }
  const decisionsDir = join(root, "decisions");
  if (existsSync(decisionsDir)) {
    try {
      const n = readdirSync(decisionsDir).filter((f) => f.endsWith(".md")).length;
      if (n > 0) lines.push(`- .zelari/decisions/ (${n} ADR file(s) — treat proposed as non-binding)`);
    } catch {
      /* ignore */
    }
  }
  const raw = lines.join("\n");
  return cap(raw, maxChars, "design-index").text;
}

/**
 * Compose project context for any dispatch path.
 * Note: durable state auto-load is sync-best-effort via a cached file read;
 * callers that already materialize async should pass `durableState` explicitly.
 */
export function composeProjectContext(
  input: ComposeProjectContextInput,
): ComposedProjectContext {
  const cwd = input.cwd ?? process.cwd();
  const warnings: string[] = [];

  const workspaceMax = envNumber(process.env.ZELARI_CTX_WORKSPACE_CHARS, {
    default: 3500,
    min: 500,
  });
  const planMax = envNumber(process.env.ZELARI_CTX_PLAN_CHARS, {
    default: 2800,
    min: 400,
  });
  const designIndexMax = envNumber(process.env.ZELARI_CTX_DESIGN_INDEX_CHARS, {
    default: 800,
    min: 200,
  });
  const memoryMax = envNumber(process.env.ZELARI_CTX_MEMORY_CHARS, {
    default: 2000,
    min: 200,
  });
  const agentsMax = envNumber(process.env.ZELARI_CTX_AGENTS_CHARS, {
    default: 6000,
    min: 500,
  });

  const wsRaw = buildWorkspaceSummary(cwd, { maxEntries: 24, maxChars: workspaceMax });
  const planRaw = buildPlanSummary(cwd, {
    userMessage: input.userMessage,
    maxChars: planMax,
  });
  const hint = buildZelariReadHint(cwd);
  const designIndex =
    input.mode === "kraken" || input.mode === "agent"
      ? buildDesignIndex(cwd, designIndexMax)
      : // Council already writes design; still give a short index, not full docs.
        buildDesignIndex(cwd, designIndexMax);

  const includeLessons =
    input.includeLessons ??
    (input.mode === "council" || input.mode === "zelari");
  const lessons = includeLessons
    ? buildLessonsSummary(cwd, input.userMessage ?? "")
    : null;

  const instr = loadProjectInstructions(cwd, agentsMax);
  if (instr.truncated) {
    warnings.push(`[context] AGENTS/project instructions truncated to ${agentsMax} chars.`);
  }

  const parts: string[] = [EPISTEMIC_BANNER, wsRaw];
  if (hint) parts.push(hint);
  if (planRaw) {
    parts.push(planRaw);
  }
  if (designIndex) parts.push(designIndex);
  if (lessons) parts.push(lessons);
  if (input.historySnippet?.trim()) parts.push(input.historySnippet.trim());

  let workspaceContext = parts.filter(Boolean).join("\n\n");
  const totalCap = envNumber(process.env.ZELARI_CTX_TOTAL_CHARS, {
    default: 12_000,
    min: 2000,
  });
  const totalCapped = cap(workspaceContext, totalCap, "workspaceContext");
  workspaceContext = totalCapped.text;
  if (totalCapped.truncated) {
    warnings.push(
      `[context] workspaceContext truncated to ${totalCap} chars (design vault demoted; use tools for detail).`,
    );
  }

  const durableMax = envNumber(process.env.ZELARI_CTX_DURABLE_CHARS, {
    default: 3000,
    min: 200,
  });
  // Default: inject durable HEAD for all modes when state is enabled, unless
  // caller passes includeDurableState: false (e.g. already merged elsewhere).
  const wantDurable =
    input.includeDurableState ??
    (process.env.ZELARI_STATE !== "0" &&
      (input.mode === "council" ||
        input.mode === "zelari" ||
        input.mode === "kraken" || input.mode === "agent"));
  let durableRaw = input.durableState?.trim() ?? "";
  // Sync fallback only when async loadDurableContext was not used upstream.
  if (!durableRaw && wantDurable) {
    durableRaw = readDurableHeadSync(cwd);
  }

  const ragParts: string[] = [];
  if (durableRaw) {
    const d = cap(durableRaw, durableMax, "durable-state");
    ragParts.push(d.text);
    if (d.truncated) {
      warnings.push(`[context] durable state truncated to ${durableMax} chars.`);
    }
  }
  if (input.memoryHits?.trim()) {
    const m = cap(input.memoryHits.trim(), memoryMax, "memory");
    ragParts.push(m.text);
    if (m.truncated) warnings.push(`[context] memory RAG truncated to ${memoryMax} chars.`);
  }
  const ragContext = ragParts.join("\n\n");

  return {
    projectInstructions: instr.content,
    workspaceContext,
    ragContext,
    warnings,
  };
}

/**
 * Sync best-effort read of durable HEAD materialization.
 * Avoids making composeProjectContext async (many call sites).
 */
function readDurableHeadSync(projectRoot: string): string {
  try {
    const headPath = join(projectRoot, ".zelari", "state", "HEAD.json");
    if (!existsSync(headPath)) return "";
    const head = JSON.parse(readFileSync(headPath, "utf8")) as { id?: string };
    if (!head?.id) return "";
    const metaPath = join(projectRoot, ".zelari", "state", "commits", `${head.id}.json`);
    if (!existsSync(metaPath)) return "";
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      id?: string;
      label?: string;
      layer?: string;
      verification?: { ok?: boolean; ran?: boolean };
      artifactDir?: string;
    };
    const discPath = meta.artifactDir
      ? join(projectRoot, ".zelari", "state", meta.artifactDir, "discoveries.json")
      : join(projectRoot, ".zelari", "state", "artifacts", head.id, "discoveries.json");
    let discoveries: Array<{
      kind?: string;
      summary?: string;
      reusable?: boolean;
      paths?: string[];
    }> = [];
    if (existsSync(discPath)) {
      discoveries = JSON.parse(readFileSync(discPath, "utf8")) as typeof discoveries;
    }
    const reusable = discoveries.filter((d) => d.reusable !== false);
    const lines = [
      `# Durable State (commit ${meta.id ?? head.id}${meta.layer ? `, layer ${meta.layer}` : ""})`,
      `label: ${meta.label ?? ""}`,
      `verification: ran=${meta.verification?.ran ?? "?"} ok=${meta.verification?.ok ?? "?"}`,
    ];
    for (const d of reusable.slice(0, 24)) {
      const pathHint = d.paths?.length ? ` — ${d.paths.join(", ")}` : "";
      lines.push(`- [${d.kind ?? "note"}] ${d.summary ?? ""}${pathHint}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}
