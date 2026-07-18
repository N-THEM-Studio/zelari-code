/**
 * Parse ---QUESTION--- blocks from assistant text (Desktop mirror of
 * @zelari/core parseClarificationRequest — no core dep in the Vite app).
 */

export interface ClarificationRequest {
  question: string;
  choices?: string[];
  context?: string;
}

const QUESTION_MARKER = "---QUESTION---";
const QUESTION_END_MARKER = "---END---";

function extractBalancedJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseClarificationRequest(
  text: string,
): ClarificationRequest | null {
  const start = text.indexOf(QUESTION_MARKER);
  if (start < 0) return null;
  const rest = text.slice(start + QUESTION_MARKER.length);
  const end = rest.indexOf(QUESTION_END_MARKER);
  const block = end >= 0 ? rest.slice(0, end) : rest;
  const cleaned = block
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const jsonText =
    extractBalancedJsonObject(cleaned) ??
    (() => {
      const objStart = cleaned.indexOf("{");
      const objEnd = cleaned.lastIndexOf("}");
      return objStart >= 0 && objEnd > objStart
        ? cleaned.slice(objStart, objEnd + 1)
        : cleaned;
    })();
  try {
    const parsed = JSON.parse(jsonText) as Partial<ClarificationRequest>;
    if (typeof parsed.question !== "string" || !parsed.question.trim()) {
      return null;
    }
    return {
      question: parsed.question.trim(),
      choices: Array.isArray(parsed.choices)
        ? parsed.choices
            .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
            .map((c) => c.trim())
        : undefined,
      context:
        typeof parsed.context === "string" ? parsed.context.trim() : undefined,
    };
  } catch {
    return null;
  }
}

/** Strip question blocks from prose (closed or trailing open). */
export function stripQuestionBlocks(text: string): string {
  return text
    .replace(/---QUESTION---[\s\S]*?---END---/g, "")
    .replace(/---QUESTION---[\s\S]*$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasQuestionMarker(text: string): boolean {
  return text.includes(QUESTION_MARKER);
}
