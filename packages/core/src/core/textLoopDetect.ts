/**
 * Detect degenerate assistant text loops (same paragraph/block repeated).
 *
 * Observed failure mode: models re-emit "Diagnosi fatta. Procedo coi 4 fix…"
 * (or equivalent intent prose) dozens of times without tool calls, burning
 * tokens until max_tokens. Harness stops the stream early when this fires.
 */

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
/** Consecutive repeats required (3 = original + 2 copies). */
const MIN_REPEATS = 3;
/** Cap how far back we scan for continuous periods (perf). */
const MAX_TAIL = 6000;
/** Max single-unit length for suffix period scan. */
const MAX_PERIOD = 600;

/** Strip light markup so `<small>foo</small>` matches bare `foo`. */
export function normalizeLoopUnit(s: string): string {
  return s
    .replace(/<\/?small>/gi, '')
    .replace(/<\/?(?:p|div|span|b|i|em|strong|br)\b[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect when the last `k` chunks form a block that repeats ≥ MIN_REPEATS
 * times at the end of `chunks`.
 */
function detectChunkSequenceLoop(
  chunks: string[],
  kind: 'paragraph' | 'line',
): TextLoopHit {
  if (chunks.length < MIN_REPEATS) return { looping: false };

  const maxK = Math.min(12, Math.floor(chunks.length / MIN_REPEATS));
  for (let k = 1; k <= maxK; k++) {
    const unitParts = chunks.slice(chunks.length - k);
    const unitKey = unitParts.join('\n');
    if (normalizeLoopUnit(unitKey).length < MIN_UNIT) continue;

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
    if (count >= MIN_REPEATS) {
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
 * Continuous period: last `period * MIN_REPEATS` chars are unit repeated.
 */
function detectSuffixPeriod(text: string): TextLoopHit {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length < MIN_UNIT * MIN_REPEATS) return { looping: false };

  const tail = compact.slice(-Math.min(compact.length, MAX_TAIL));
  const maxP = Math.min(MAX_PERIOD, Math.floor(tail.length / MIN_REPEATS));

  for (let period = MIN_UNIT; period <= maxP; period++) {
    const need = period * MIN_REPEATS;
    if (tail.length < need) continue;
    const unit = tail.slice(tail.length - period);
    if (normalizeLoopUnit(unit).length < MIN_UNIT * 0.55) continue;

    let ok = true;
    for (let r = 1; r < MIN_REPEATS; r++) {
      const start = tail.length - period * (r + 1);
      if (tail.slice(start, start + period) !== unit) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Count full consecutive trailing repeats
    let count = MIN_REPEATS;
    let end = tail.length - period * MIN_REPEATS;
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
  if (!text || text.length < MIN_UNIT * MIN_REPEATS) {
    return { looping: false };
  }

  const nl = text.replace(/\r\n/g, '\n');

  // 1) Multi-paragraph blocks (blank-line separated chunks, sequence of k).
  //    Handles diagnosis multi-line units that repeat as a whole.
  const paragraphs = nl
    .split(/\n\s*\n+/)
    .map((p) => normalizeLoopUnit(p))
    .filter((p) => p.length > 0);
  const paraHit = detectChunkSequenceLoop(paragraphs, 'paragraph');
  if (paraHit.looping) return paraHit;

  // 2) Line-level sequence (single newlines).
  const lines = nl
    .split('\n')
    .map((l) => normalizeLoopUnit(l))
    .filter((l) => l.length > 0);
  const lineHit = detectChunkSequenceLoop(lines, 'line');
  if (lineHit.looping) return lineHit;

  // 3) Continuous suffix periods (no separators / different unit lengths).
  return detectSuffixPeriod(nl);
}

/**
 * Keep the first two occurrences of a looped unit; drop the rest.
 * Used when sealing the assistant transcript so the next turn is not polluted.
 */
export function collapseLoopedAssistantText(text: string): string {
  const hit = detectAssistantTextLoop(text);
  if (!hit.looping) return text;

  const note = `\n\n[system: stopped repeating the same text ×${hit.count}; call tools or finish.]`;

  if (hit.kind === 'paragraph' || hit.kind === 'line') {
    const joinSep = hit.kind === 'paragraph' ? '\n\n' : '\n';
    // Rebuild using normalized comparison against unit parts
    const unitParts = hit.unit.split('\n').map((p) => normalizeLoopUnit(p));
    const k = unitParts.length;
    if (k === 0) return text + note;

    const rawParts = text
      .replace(/\r\n/g, '\n')
      .split(hit.kind === 'paragraph' ? /\n\s*\n+/ : /\n/)
      .filter((p) => normalizeLoopUnit(p).length > 0);

    if (rawParts.length < k * MIN_REPEATS) {
      // Fallback: cut by character using unit length × excess
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

    if (trailBlocks < MIN_REPEATS) {
      return collapseByCharBudget(text, hit.unit, hit.count) + note;
    }

    const keepBlocks = 2;
    const keepParts = rawParts.slice(0, rawParts.length - k * (trailBlocks - keepBlocks));
    return keepParts.join(joinSep).trimEnd() + note;
  }

  // Suffix
  return collapseByCharBudget(text, hit.unit, hit.count) + note;
}

function collapseByCharBudget(text: string, unit: string, count: number): string {
  const unitLen = Math.max(unit.length, MIN_UNIT);
  if (count < MIN_REPEATS) return text;
  const drop = unitLen * (count - 2);
  const cut = Math.max(0, text.length - drop);
  return text.slice(0, cut).trimEnd();
}
