/**
 * languagePolicy — language detection + system-prompt directive for
 * "respond in the user's language" behavior across all three Zelari Code
 * modes (single agent, council, zelari-mode).
 *
 * Design constraints:
 *  - Deterministic + dependency-free. We do NOT call an LLM to detect
 *    language — that would be a loop, and slow. The detection uses
 *    script-level signals (accented chars, CJK ranges) plus a small
 *    stopword set. Italian is the fallback because zelari-code is an
 *    N-THEM Studio CLI and the default TUI prompts are IT-flavored.
 *  - Override wins. `ZELARI_RESPONSE_LANG=it|en|auto|...` bypasses
 *    detection. `auto` (= the default when unset) re-enables detection.
 *  - One source of truth. The directive text and the detection helper
 *    live in the same module so they cannot drift. The directive is a
 *    `SystemPromptModule` that callers append to `customPromptModules`
 *    (or to the inline agent role prompt for legacy paths).
 *
 * Recognized languages (set by detection):
 *   'it' | 'en' | 'fr' | 'es' | 'de' | 'pt' | 'nl' | 'zh' | 'ja' | 'ko' | 'ru' | 'ar'
 *
 * Anything else (or empty / symbol-only input) → 'it' (fallback).
 */

/** Languages the policy can address. Add a row here when adding detection signals. */
export type SupportedLanguage =
  | 'it' | 'en' | 'fr' | 'es' | 'de' | 'pt' | 'nl'
  | 'zh' | 'ja' | 'ko' | 'ru' | 'ar';

/** ISO-ish labels for the directive prompt (the model reads them). */
const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  it: 'Italian',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  pt: 'Portuguese',
  nl: 'Dutch',
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  ar: 'Arabic',
};

/** Canonical script / accent signals per language. Cheap to scan. */
const SCRIPT_RANGES: Array<{ lang: SupportedLanguage; ranges: Array<[number, number]> }> = [
  // v1.7.0 fix: ja/kr MUST come before zh — kanji (CJK Unified) and hangul
  // glyphs can fall in either's range when both languages are present, but
  // hiragana/katakana (ja) and hangul jamo (kr) are unique owners. A mixed
  // string like "こんにちは、関数の作り方を…" had kanji that triggered the
  // zh range first, returning 'zh' for a clearly-Japanese message.
  { lang: 'ja', ranges: [[0x3040, 0x309f], [0x30a0, 0x30ff]] },
  { lang: 'ko', ranges: [[0xac00, 0xd7af], [0x1100, 0x11ff]] },
  { lang: 'zh', ranges: [[0x4e00, 0x9fff]] },
  { lang: 'ar', ranges: [[0x0600, 0x06ff]] },
  { lang: 'ru', ranges: [[0x0400, 0x04ff]] },
];

/** Is this code point a letter (alphabetic in any script)? */
function isLetter(cp: number): boolean {
  return (
    (cp >= 0x0041 && cp <= 0x005a) ||   // A-Z
    (cp >= 0x0061 && cp <= 0x007a) ||   // a-z
    (cp >= 0x00c0 && cp <= 0x024f) ||   // Latin-1 supplement + Extended A/B
    (cp >= 0x1e00 && cp <= 0x1eff) ||   // Latin Extended Additional
    (cp >= 0x0370 && cp <= 0x03ff) ||   // Greek
    (cp >= 0x0400 && cp <= 0x04ff) ||   // Cyrillic
    (cp >= 0x0590 && cp <= 0x05ff) ||   // Hebrew
    (cp >= 0x0600 && cp <= 0x06ff) ||   // Arabic
    (cp >= 0x0900 && cp <= 0x097f) ||   // Devanagari
    (cp >= 0x3040 && cp <= 0x30ff) ||   // Hiragana + Katakana
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified
    (cp >= 0xac00 && cp <= 0xd7af)      // Hangul syllables
  );
}

/** Is this code point a Latin script character (basic Latin + Latin-1 supplement + Extended A/B)? */
function isLatinChar(cp: number): boolean {
  return (
    (cp >= 0x0041 && cp <= 0x005a) ||   // A-Z
    (cp >= 0x0061 && cp <= 0x007a) ||   // a-z
    (cp >= 0x00c0 && cp <= 0x024f) ||   // Latin-1 supplement + Extended A/B
    (cp >= 0x1e00 && cp <= 0x1eff)      // Latin Extended Additional
  );
}

/** Latin-accent signals per language (single char or 2-char combo hits). */
const ACCENT_SIGNALS: Array<{ lang: SupportedLanguage; chars: string }> = [
  { lang: 'it', chars: 'àèéìòóùù' },
  { lang: 'fr', chars: 'àâçèéêëîïôùûüœæ' },
  { lang: 'de', chars: 'äöüß' },
  { lang: 'es', chars: 'áéíñóúü¿¡' },
  { lang: 'pt', chars: 'ãáàâçéêíõóôúü' },
  { lang: 'nl', chars: 'áèéëíóöúü' },
];

/**
 * Function-word signals — the strongest single-signal hint in mixed prose.
 * Lowercase match, word-boundary aware. Keep small (5-12 entries per lang)
 * to stay fast on large inputs.
 */
const FUNCTION_WORDS: Record<Exclude<SupportedLanguage, 'zh' | 'ja' | 'ko' | 'ar' | 'ru'>, string[]> = {
  it: ['il', 'lo', 'la', 'gli', 'le', 'un', 'uno', 'una', 'di', 'del', 'della', 'dei',
       'e', 'che', 'chi', 'come', 'con', 'per', 'non', 'sono',
       'questo', 'questa', 'quello', 'quella', 'fare', 'fai', 'crea', 'creare', 'mostra',
       'ciao', 'grazie', 'bene', 'male', 'puoi', 'come', 'cosa', 'questo'],
  en: ['the', 'a', 'an', 'of', 'and', 'is', 'are', 'was', 'were', 'to', 'for',
       'with', 'that', 'this', 'these', 'those', 'do', 'does', 'make', 'create',
       'show', 'hello', 'help', 'please', 'thanks', 'how', 'what', 'where', 'why'],
  fr: ['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'est', 'sont',
       'que', 'qui', 'avec', 'pour', 'dans', 'pas', 'oui', 'non', 'faire', 'créer',
       'bonjour', 'merci', 'bien'],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'y', 'es', 'son',
       'que', 'con', 'por', 'para', 'no', 'sí', 'hacer', 'crear', 'mostrar',
       'hola', 'gracias', 'bueno'],
  de: ['der', 'die', 'das', 'den', 'dem', 'des', 'und', 'ist', 'sind', 'nicht',
       'mit', 'für', 'auf', 'zu', 'ja', 'nein', 'machen', 'erstellen', 'zeigen',
       'hallo', 'danke', 'gut'],
  pt: ['o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'e', 'é', 'são',
       'que', 'com', 'para', 'não', 'sim', 'fazer', 'criar', 'mostrar',
       'olá', 'obrigado', 'bom'],
  nl: ['de', 'het', 'een', 'van', 'en', 'is', 'zijn', 'niet', 'met', 'voor',
       'ja', 'nee', 'doen', 'maken', 'tonen', 'hallo', 'dank', 'goed'],
};

/**
 * Detect the response language from a user message.
 *
 * Strategy (in order, first decisive match wins):
 *   1. Dominant non-Latin script (CJK, Cyrillic, Arabic, …) → that
 *      language, BUT only when non-Latin characters dominate the input.
 *      A single foreign word in an otherwise-English prompt (e.g. quoting
 *      a Chinese character) must NOT hijack the response language — that
 *      bug was caught by the v1.7.0 fresh-eyes audit.
 *   2. Latin-accent set with a unique owner (e.g. 'ñ' or 'ç' or 'ß') → that language.
 *   3. Function-word scoring (count hits per language, ties broken by
 *      italian preference, then english preference — matches the CLI default).
 *   4. Empty / symbol-only / undecided → 'it' (N-THEM Studio default).
 *
 * Caller-controlled overrides (ZELARI_RESPONSE_LANG) are applied OUTSIDE
 * this function so it stays a pure, easy-to-test helper.
 */
export function detectResponseLanguage(text: string): SupportedLanguage {
  if (!text || text.trim().length === 0) return 'it';

  // Normalize: lowercase, strip code blocks (those skew detection when the
  // user pastes JS/Rust/Python). We keep punctuation — it's a signal too.
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .toLowerCase();
  if (stripped.trim().length === 0) return 'it';

  // 1. Script ranges — only count as a match when the script DOMINATES.
  //    A prompt with 1 Chinese character quoted inside 200 English words
  //    must still detect English, not Chinese.
  //
  //    The ratio is computed over LETTERS ONLY — digits, spaces, and ASCII
  //    punctuation are script-neutral and must NOT inflate the non-Latin
  //    ratio. Counting all non-Latin chars (which the v1.7.0 first attempt
  //    did) made a single Russian word quoted in English tip past the 30%
  //    threshold because smart quotes + em-dashes counted as "non-Latin".
  //    The fresh-eyes audit caught this on the regression test "does NOT
  //    detect ru when a single Cyrillic word is quoted in an English prompt".
  let totalLetters = 0;
  let nonLatinLetters = 0;
  for (let i = 0; i < stripped.length; i++) {
    const cp = stripped.codePointAt(i);
    if (cp === undefined) continue;
    if (!isLetter(cp)) continue; // skip digits, spaces, ASCII punctuation
    totalLetters += 1;
    if (!isLatinChar(cp)) nonLatinLetters += 1;
  }
  const nonLatinRatio = totalLetters > 0 ? nonLatinLetters / totalLetters : 0;
  // Threshold: 30% of LETTERS must be non-Latin. Below this, treat the
  // input as Latin-script with foreign quotes (the user's language stays).
  const SCRIPT_DOMINANCE_THRESHOLD = 0.30;
  if (nonLatinRatio >= SCRIPT_DOMINANCE_THRESHOLD) {
    for (const { lang, ranges } of SCRIPT_RANGES) {
      for (const [lo, hi] of ranges) {
        for (let i = 0; i < stripped.length; i++) {
          const cp = stripped.codePointAt(i);
          if (cp !== undefined && cp >= lo && cp <= hi) return lang;
        }
      }
    }
  }

  // 2. Latin-accent signals — each accent votes for its owner language(s).
//    Some chars are shared across multiple latin languages (ü, é, etc.)
//    so we accumulate votes rather than declaring a winner here. The
//    unique-ownership chars (ñ, ç, ß, œ, æ, ã, õ) get bonus weight so a
//    single hit still wins decisively.
type AccentVote = { lang: SupportedLanguage; weight: number; chars: string };
const ACCENT_VOTES: AccentVote[] = [
  // Italian-specific
  { lang: 'it', weight: 2, chars: 'àèéìòóù' },
  // French-only accents
  { lang: 'fr', weight: 2, chars: 'âçêëîïôûœæ' },
  // German-only
  { lang: 'de', weight: 3, chars: 'äöüß' },
  // Spanish-only (ñ is the discriminator)
  { lang: 'es', weight: 3, chars: 'ñáíóú¿¡' },
  // Portuguese-only (ã/õ are the discriminator)
  { lang: 'pt', weight: 3, chars: 'ãõáéíóúâêô' },
  // Dutch-only
  { lang: 'nl', weight: 2, chars: 'áèéëíóöúü' },
];

  // Accent scoring: tally votes per language. Highest weight wins.
  const accentScores: Partial<Record<SupportedLanguage, number>> = {};
  for (const { lang, weight, chars } of ACCENT_VOTES) {
    let hits = 0;
    for (const c of chars) if (stripped.includes(c)) hits += 1;
    if (hits > 0) accentScores[lang] = (accentScores[lang] ?? 0) + weight * hits;
  }
  const accentOrdered: SupportedLanguage[] = (Object.entries(accentScores) as Array<[SupportedLanguage, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([l]) => l);
  if (accentOrdered.length > 0 && accentOrdered.length === 1) {
    return accentOrdered[0]; // unambiguous single-owner
  }
  if (accentOrdered.length > 1) {
    // Multiple accent owners present: take the highest-weighted one. This
    // fixes the "opções → fr" bug: 'ç' (fr) + 'ã' (pt) tie by raw count
    // but 'ã' is weight 3 vs 'ç' weight 2, so pt wins on Portuguese text.
    return accentOrdered[0];
  }

  // 3. Function-word scoring. Tokenize on whitespace + basic punctuation.
  const tokens = stripped.split(/[\s,;.!?()\[\]{}<>:'"\\/]+/).filter((t) => t.length > 1);
  if (tokens.length === 0) return 'it';
  const scores: Partial<Record<SupportedLanguage, number>> = {};
  for (const [lang, words] of Object.entries(FUNCTION_WORDS) as Array<
    [Exclude<SupportedLanguage, 'zh' | 'ja' | 'ko' | 'ar' | 'ru'>, string[]]
  >) {
    let hits = 0;
    // Exact-match lookup against the token set. We do NOT use startsWith
    // here — "create" must NOT match the italian lemma "crea" (the reverse
    // direction is the bug we'd otherwise introduce; "crea" stays in the IT
    // list and matches itself).
    const tokenSet = new Set(tokens);
    for (const w of words) {
      if (tokenSet.has(w)) hits += 1;
    }
    if (hits > 0) scores[lang] = hits;
  }
  // Tie-break: italian wins, then english (matches zelari-code defaults).
  const ordered: SupportedLanguage[] = (Object.entries(scores) as Array<[SupportedLanguage, number]>)
    .sort((a, b) => b[1] - a[1] || (a[0] === 'it' ? -1 : b[0] === 'it' ? 1 : 0))
    .map(([l]) => l);
  if (ordered.length > 0) return ordered[0];

  // 4. Fallback.
  return 'it';
}

/**
 * Resolve the effective response language, honoring the env override.
 *
 * Env values:
 *   - `auto` (default): run detection.
 *   - `it|en|fr|...`: force that language.
 *   - any other value: warn to stderr and fall back to detection (defensive
 *     — we never throw from a prompt-side helper, but a misconfigured
 *     env var should not be silently ignored either). The agy audit (v1.7.0
 *     L2) flagged that a typo (e.g. `ZELARI_RESPONSE_LANG=eng` or `=IT_en`)
 *     would silently fall through to detection, which made "the directive
 *     isn't doing what I expected" debugging hard. The warning routes to
 *     `console.warn` so it surfaces in the TUI log even when stderr is
 *     not piped.
 */
export function resolveResponseLanguage(
  text: string,
  env: Record<string, string | undefined> = process.env,
): SupportedLanguage {
  const raw = env.ZELARI_RESPONSE_LANG?.trim().toLowerCase();
  if (raw && raw !== 'auto') {
    if (raw in LANGUAGE_LABELS) return raw as SupportedLanguage;
    // v1.7.0 (agy audit L2): surface the misconfiguration instead of
    // silently falling back. The warn is gated on env.WARNING emission;
    // tests that pass a custom `env` without stderr capture can override
    // `__zelariLangWarnSink` to silence.
    const sink = (globalThis as { __zelariLangWarnSink?: (msg: string) => void }).__zelariLangWarnSink
      ?? ((msg: string) => console.warn(`[zelari-code] ${msg}`));
    sink(
      `ZELARI_RESPONSE_LANG='${env.ZELARI_RESPONSE_LANG}' is not a supported language ` +
      `(known: ${Object.keys(LANGUAGE_LABELS).join(', ')}, or 'auto'). ` +
      `Falling back to detection.`,
    );
  }
  return detectResponseLanguage(text);
}

/**
 * Build the system-prompt directive that tells the model which language to
 * reply in. Two layers of defense:
 *
 *   1. Explicit, natural-language instruction: the model reads "Reply in <X>".
 *   2. Domain coverage: enumerates ALL 3 modes so a council member who
 *      hasn't seen a prior conversation still picks the right language.
 *
 * The directive is `priority: 5` so it sorts BEFORE the base-identity
 * modules (10) — the language decision is contextual scaffolding, not
 * identity, and the model should set it before reading role text.
 */
export function buildLanguageDirective(lang: SupportedLanguage): string {
  const label = LANGUAGE_LABELS[lang];
  return `# Response Language — ${label}

Reply in **${label}** for the entirety of your response, including any final synthesis, clarifying questions, and tool-call descriptions. This directive applies in all modes (single agent, council members, zelari slices):

- Read the user's last message in context and mirror its language. If the user's prompt is in ${label}, reply in ${label}. If it mixes languages, default to ${label}.
- Do not switch to English (or any other language) for code, error messages, tool names, file paths, or technical terms — code is language-neutral and stays as-is.
- If the user explicitly asks for a different language in the same turn (e.g. "reply in English"), honor that request for the rest of this turn only.
- For clarifying questions (---QUESTION--- blocks), write the \`question\` and \`choices\` fields in ${label} so the picker UI matches the user's language.
- For council synthesis (Lucifero) and any final-answer turn, the user-visible text is in ${label}; intermediate specialist notes that the user never sees directly can stay in their working language.`;
}

/**
 * Build a single module for the common case. Callers pass it through
 * `customPromptModules` (or append directly to the role prompt for
 * legacy paths).
 *
 * v1.7.0 fix: the module type is `'language-policy'` (a dedicated slot in
 * `PromptModuleType`), NOT `'custom'`. The system prompt builder filters
 * base modules of the SAME type as any custom module
 * (`baseNotOverridden = baseModules.filter(m => !customTypes.has(m.type))`).
 * If we used `'custom'`, we'd silently drop the 5 most important base
 * directives (Structured Reasoning, Collaboration, Tool-Use Protocol,
 * Output Quality, Clarification Protocol) — all of which are typed
 * `'custom'` themselves. This bug was caught by the v1.7.0 fresh-eyes
 * audit (agy/Gemini) before release.
 *
 * v1.7.0 priority note (agy audit L3): `priority: 5` is a NAMESPACE VALUE,
 * not the absolute ordering. `systemPromptBuilder.ts:167` offsets custom
 * modules by `1000 + priority`, so the effective sort key is 1005 — well
 * AFTER every base module (priority 10-60). This is by design: custom
 * modules should never reorder base directives, only append. The base-
 * identity module keeps its identity slot because of the
 * `customTypes.has('base-identity')` override filter, which is unrelated
 * to priority sorting.
 */
import type { SystemPromptModule } from '../types/systemTypes.js';

export const LANGUAGE_POLICY_MODULE_TYPE = 'language-policy';

export function buildLanguagePolicyModule(lang: SupportedLanguage): SystemPromptModule {
  return {
    type: LANGUAGE_POLICY_MODULE_TYPE,
    title: `Response Language (${LANGUAGE_LABELS[lang]})`,
    priority: 5,
    content: buildLanguageDirective(lang),
  };
}

/**
 * One-shot helper used by every dispatch entry-point (single, council,
 * zelari, headless). Reads `ZELARI_RESPONSE_LANG` and the user message,
 * returns the module to inject.
 *
 * Callers that already have the detected language (e.g. the council, which
 * builds ONE module per run and reuses it for every member) can skip this
 * and use `buildLanguagePolicyModule` directly.
 */
export function buildLanguagePolicyModuleFor(
  userText: string,
  env: Record<string, string | undefined> = process.env,
): SystemPromptModule {
  return buildLanguagePolicyModule(resolveResponseLanguage(userText, env));
}