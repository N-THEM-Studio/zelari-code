/**
 * Detect degenerate assistant text loops (same paragraph/block repeated).
 *
 * Observed failure mode: models re-emit "Diagnosi fatta. Procedo coi 4 fix…"
 * or "Bene. dungeon.js fatto. Aggiorno todo e procedo con inventory" dozens of
 * times without tool calls, burning tokens until max_tokens. Harness stops the
 * stream early when this fires.
 *
 * After a stop, {@link TEXT_LOOP_RECOVERY_SYSTEM} is appended so the next
 * provider turn is steered to tools + a clean conclude-or-ask finish.
 */

/**
 * System message injected into rolling history after a text-loop stop.
 * Short, imperative — optimized for the next user/provider turn.
 */
export const TEXT_LOOP_RECOVERY_SYSTEM = [
  '[text-loop recovery] Your previous reply was stopped: you repeated status text',
  'instead of finishing (no clean conclusion).',
  '',
  'On the next turn you MUST:',
  '1) list_files / read_file what already exists (do not re-plan the whole project).',
  '2) Apply at most ONE small disk change with write_file/edit_file if still needed.',
  '3) Then STOP with either:',
  '   A) Done — paths changed + how to verify, or',
  '   B) Short resoconto (done / next) and ask_user whether to continue.',
  '4) Forbidden: more "procedo con / aggiorno todo / ora creo" monologue without tools.',
].join('\n');

/**
 * Suggested user message for TUI/Desktop "Continue with tools" actions.
 */
export const TEXT_LOOP_RECOVERY_USER_PROMPT = [
  'Continue from the text-loop stop.',
  'Inspect disk, apply at most one missing piece with tools if needed,',
  'then either mark DONE with a short verify list OR give a brief resoconto and ask if I want you to continue.',
  'No status theater, no full rewrite.',
].join(' ');

export type TextLoopHit =
  | {
      looping: true;
      unit: string;
      count: number;
      kind: 'paragraph' | 'line' | 'suffix';
    }
  | { looping: false };

/** Min unit length so short echoes ("ok ok ok") do not trip the guard. */
const MIN_UNIT = 48;
/** Consecutive repeats for generic prose (original + 2 copies). */
const MIN_REPEATS = 3;
/**
 * Status-theater monologues ("Procedo con…", "Aggiorno todo…") trip earlier
 * so the model cannot burn a whole turn on intention spam.
 */
const MIN_REPEATS_STATUS = 2;
/** Cap how far back we scan for continuous periods (perf). */
const MAX_TAIL = 6000;
/** Max single-unit length for suffix period scan. */
const MAX_PERIOD = 600;

/**
 * Meta-progress / status theater (IT + EN). When this matches, fewer repeats
 * are required to stop the stream.
 */
export function isStatusTheaterUnit(unit: string): boolean {
  const u = normalizeLoopUnit(unit).toLowerCase();
  if (u.length < 32) return false;
  return (
    /\b(procedo|procediamo|continuo|continuiamo)\b/.test(u) ||
    /\b(aggiorno|updating)\s+(il\s+)?todo\b/.test(u) ||
    /\bora\s+(creo|creo|scrivo|implemento|faccio)\b/.test(u) ||
    /\b(next\s+i\s+will|i\s+will\s+(now\s+)?(create|write|implement|update))\b/.test(
      u,
    ) ||
    /\b(let\s+me\s+(now\s+)?(create|write|update|proceed))\b/.test(u) ||
    /\b(fatto\.?\s*(ora|next|procedo)|bene\.?\s*(ora|procedo|aggiorno))\b/.test(
      u,
    ) ||
    /\b(todo\s+(list\s+)?updated|moving\s+on\s+to)\b/.test(u)
  );
}

/** Strip light markup so `<small>foo</small>` matches bare `foo`. */
export function normalizeLoopUnit(s: string): string {
  return s
    .replace(/<\/?small>/gi, '')
    .replace(/<\/?(?:p|div|span|b|i|em|strong|br)\b[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect when the last `k` chunks form a block that repeats enough times.
 * Status-theater units need only {@link MIN_REPEATS_STATUS} consecutive copies.
 */
function detectChunkSequenceLoop(
  chunks: string[],
  kind: 'paragraph' | 'line',
): TextLoopHit {
  if (chunks.length < MIN_REPEATS_STATUS) return { looping: false };

  const maxK = Math.min(12, Math.floor(chunks.length / MIN_REPEATS_STATUS));
  for (let k = 1; k <= maxK; k++) {
    const unitParts = chunks.slice(chunks.length - k);
    const unitKey = unitParts.join('\n');
    const norm = normalizeLoopUnit(unitKey);
    if (norm.length < MIN_UNIT) continue;

    const need = isStatusTheaterUnit(unitKey) ? MIN_REPEATS_STATUS : MIN_REPEATS;
    if (chunks.length < need * k) continue;

    let count = 1;
    let pos = chunks.length - k;
    while (pos - k >= 0) {
      const prev = chunks.slice(pos - k, pos);
      let same = true;
      for (let i = 0; i < k; i++) {
        if (prev[i] !== unitParts[i]) {
          same = false;
          break;
        }
      }
      if (!same) break;
      count++;
      pos -= k;
    }
    if (count >= need) {
      return {
        looping: true,
        unit: unitKey,
        count,
        kind,
      };
    }
  }
  return { looping: false };
}

/**
 * Continuous period: last `period * need` chars are unit repeated.
 */
function detectSuffixPeriod(text: string): TextLoopHit {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length < MIN_UNIT * MIN_REPEATS_STATUS) return { looping: false };

  const tail = compact.slice(-Math.min(compact.length, MAX_TAIL));
  const maxP = Math.min(MAX_PERIOD, Math.floor(tail.length / MIN_REPEATS_STATUS));

  for (let period = MIN_UNIT; period <= maxP; period++) {
    const unit = tail.slice(tail.length - period);
    if (normalizeLoopUnit(unit).length < MIN_UNIT * 0.55) continue;

    const need = isStatusTheaterUnit(unit) ? MIN_REPEATS_STATUS : MIN_REPEATS;
    const needChars = period * need;
    if (tail.length < needChars) continue;

    let ok = true;
    for (let r = 1; r < need; r++) {
      const start = tail.length - period * (r + 1);
      if (tail.slice(start, start + period) !== unit) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    let count = need;
    let end = tail.length - period * need;
    while (end >= period && tail.slice(end - period, end) === unit) {
      count++;
      end -= period;
    }
    return {
      looping: true,
      unit,
      count,
      kind: 'suffix',
    };
  }
  return { looping: false };
}

/**
 * Returns a hit when `text` ends with the same substantial unit repeated
 * enough times to indicate model degeneration (not normal prose).
 */
export function detectAssistantTextLoop(text: string): TextLoopHit {
  if (!text || text.length < MIN_UNIT * MIN_REPEATS_STATUS) {
    return { looping: false };
  }

  const nl = text.replace(/\r\n/g, '\n');

  const paragraphs = nl
    .split(/\n\s*\n+/)
    .map((p) => normalizeLoopUnit(p))
    .filter((p) => p.length > 0);
  const paraHit = detectChunkSequenceLoop(paragraphs, 'paragraph');
  if (paraHit.looping) return paraHit;

  const lines = nl
    .split('\n')
    .map((l) => normalizeLoopUnit(l))
    .filter((l) => l.length > 0);
  const lineHit = detectChunkSequenceLoop(lines, 'line');
  if (lineHit.looping) return lineHit;

  return detectSuffixPeriod(nl);
}

/**
 * Keep the first two occurrences of a looped unit; drop the rest.
 * Used when sealing the assistant transcript so the next turn is not polluted.
 */
export function collapseLoopedAssistantText(text: string): string {
  const hit = detectAssistantTextLoop(text);
  if (!hit.looping) return text;

  const note =
    `\n\n[system: stopped repeating the same text ×${hit.count}.]\n` +
    TEXT_LOOP_RECOVERY_SYSTEM;

  if (hit.kind === 'paragraph' || hit.kind === 'line') {
    const joinSep = hit.kind === 'paragraph' ? '\n\n' : '\n';
    const unitParts = hit.unit.split('\n').map((p) => normalizeLoopUnit(p));
    const k = unitParts.length;
    if (k === 0) return text + note;

    const rawParts = text
      .replace(/\r\n/g, '\n')
      .split(hit.kind === 'paragraph' ? /\n\s*\n+/ : /\n/)
      .filter((p) => normalizeLoopUnit(p).length > 0);

    const minNeed = isStatusTheaterUnit(hit.unit)
      ? MIN_REPEATS_STATUS
      : MIN_REPEATS;

    if (rawParts.length < k * minNeed) {
      return collapseByCharBudget(text, hit.unit, hit.count) + note;
    }

    let trailBlocks = 0;
    let pos = rawParts.length;
    while (pos >= k) {
      let same = true;
      for (let i = 0; i < k; i++) {
        if (normalizeLoopUnit(rawParts[pos - k + i]!) !== unitParts[i]) {
          same = false;
          break;
        }
      }
      if (!same) break;
      trailBlocks++;
      pos -= k;
    }

    if (trailBlocks < minNeed) {
      return collapseByCharBudget(text, hit.unit, hit.count) + note;
    }

    const keepBlocks = Math.min(2, trailBlocks);
    const keepParts = rawParts.slice(
      0,
      rawParts.length - k * (trailBlocks - keepBlocks),
    );
    return keepParts.join(joinSep).trimEnd() + note;
  }

  return collapseByCharBudget(text, hit.unit, hit.count) + note;
}

function collapseByCharBudget(text: string, unit: string, count: number): string {
  const unitLen = Math.max(unit.length, MIN_UNIT);
  if (count < 2) return text;
  const keep = Math.min(2, count);
  const drop = unitLen * (count - keep);
  const cut = Math.max(0, text.length - drop);
  return text.slice(0, cut).trimEnd();
}
