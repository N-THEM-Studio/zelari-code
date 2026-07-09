/**
 * Tests for the language-policy module: detection, env override, and the
 * directive-module shape consumed by buildSystemPrompt.
 *
 * Detection is heuristic, so each test pins ONE signal class to keep
 * regressions localizable:
 *   - unique-accent (es/pt/de/fr)
 *   - script range (zh/ja/ko/ru/ar)
 *   - function-word majority (en vs it)
 *   - env override (`ZELARI_RESPONSE_LANG` wins)
 *   - empty / symbol-only fallback (it)
 */
import { describe, it, expect } from 'vitest';
import {
  detectResponseLanguage,
  resolveResponseLanguage,
  buildLanguageDirective,
  buildLanguagePolicyModule,
  buildLanguagePolicyModuleFor,
  LANGUAGE_POLICY_MODULE_TYPE,
} from '@zelari/core/skills';

describe('detectResponseLanguage', () => {
  it('returns it for empty / whitespace / symbol-only input', () => {
    expect(detectResponseLanguage('')).toBe('it');
    expect(detectResponseLanguage('   ')).toBe('it');
    expect(detectResponseLanguage('(){}[]')).toBe('it');
  });

  it('detects italian from unique accent + function words', () => {
    expect(detectResponseLanguage('Per favore crea una funzione che è veloce.')).toBe('it');
    expect(detectResponseLanguage('Ciao, come posso fare questa cosa con il tuo aiuto?')).toBe('it');
  });

  it('detects english from function-word majority', () => {
    expect(detectResponseLanguage('Please create a function that is fast and clean.')).toBe('en');
    expect(detectResponseLanguage('Show me how to do this with the tool.')).toBe('en');
  });

  it('detects spanish from ñ', () => {
    expect(detectResponseLanguage('Muéstrame el código del año pasado.')).toBe('es');
  });

  it('detects french from ç', () => {
    expect(detectResponseLanguage('Ça ne marche pas, comment faire ?')).toBe('fr');
  });

  it('detects german from ß', () => {
    expect(detectResponseLanguage('Das geht nicht, ich weiß nicht wie.')).toBe('de');
  });

  it('detects portuguese from ã/õ', () => {
    expect(detectResponseLanguage('Não sei como fazer isso, são muitas opções.')).toBe('pt');
  });

  it('detects chinese from CJK ranges', () => {
    expect(detectResponseLanguage('你好, 请帮我创建一个函数')).toBe('zh');
  });

  it('detects japanese from hiragana/katakana ranges', () => {
    expect(detectResponseLanguage('こんにちは、関数の作り方を教えてください。')).toBe('ja');
  });

  it('detects korean from hangul ranges', () => {
    expect(detectResponseLanguage('안녕하세요, 함수를 만드는 방법을 보여주세요.')).toBe('ko');
  });

  it('detects russian from cyrillic ranges', () => {
    expect(detectResponseLanguage('Привет, покажи как создать функцию.')).toBe('ru');
  });

  it('detects arabic from arabic ranges', () => {
    expect(detectResponseLanguage('مرحبا، أرني كيف أنشئ دالة')).toBe('ar');
  });

  it('does NOT detect zh when a single CJK character is quoted in an English prompt (regression)', () => {
    // A common pattern: "What does the Chinese character 你 mean?" The single
    // CJK character would dominate under the old "first match wins" script
    // check (the v1.7.0 fresh-eyes audit caught this). With the dominance
    // threshold (>= 30% non-Latin), the CJK ratio is ~1/40 — below the
    // threshold — and English function words win.
    expect(detectResponseLanguage('What does the Chinese character 你 mean in this context?')).toBe('en');
  });

  it('does NOT detect ru when a single Cyrillic word is quoted in an English prompt', () => {
    expect(detectResponseLanguage('The Russian word for "hello" is привет — please add it to the dictionary.')).toBe('en');
  });

  it('does NOT detect ar when a single Arabic word is quoted in an English prompt', () => {
    expect(detectResponseLanguage('The Arabic greeting مرحبا is common, please include it.')).toBe('en');
  });

  it('still detects a fully CJK prompt (dominance threshold not exceeded by accident)', () => {
    expect(detectResponseLanguage('你好, 请帮我创建一个函数来计算斐波那契数列。')).toBe('zh');
  });

  it('strips code blocks before scoring (avoids JS keywords skewing detection)', () => {
    // The prose is italian; the code block is english-looking JS. Detection
    // should not flip to en because of the code.
    const text = `Per favore correggi questo:
\`\`\`js
const x = function() { return 1; };
\`\`\`
Come puoi vedere è banale.`;
    expect(detectResponseLanguage(text)).toBe('it');
  });

  it('strips inline backticks before scoring', () => {
    expect(detectResponseLanguage('Usa la funzione `render` per mostrare il risultato.')).toBe('it');
  });

  it('tie-breaks italian over english (matches zelari-code default)', () => {
    // Both languages have similar function-word hit counts. Italian wins
    // by tie-break so an ambiguous /code-heavy prompt stays IT.
    expect(detectResponseLanguage('il the la a and un an')).toBe('it');
  });
});

describe('resolveResponseLanguage', () => {
  it('honors ZELARI_RESPONSE_LANG=it over detection', () => {
    expect(resolveResponseLanguage('Hello, please create a function', { ZELARI_RESPONSE_LANG: 'it' })).toBe('it');
  });

  it('honors ZELARI_RESPONSE_LANG=en over detection', () => {
    expect(resolveResponseLanguage('Per favore crea una funzione', { ZELARI_RESPONSE_LANG: 'en' })).toBe('en');
  });

  it('treats ZELARI_RESPONSE_LANG=auto as detection', () => {
    expect(resolveResponseLanguage('Hello, please create a function', { ZELARI_RESPONSE_LANG: 'auto' })).toBe('en');
  });

  it('rejects invalid language values with a warning (agy audit L2) and falls back to detection', () => {
    // Pin the sink so the test doesn't print noise; assert it received
    // the warning so a future "silence the warn" regression is caught.
    const captured: string[] = [];
    (globalThis as any).__zelariLangWarnSink = (msg: string) => { captured.push(msg); };
    try {
      expect(resolveResponseLanguage('Per favore crea una funzione', { ZELARI_RESPONSE_LANG: 'klingon' })).toBe('it');
      expect(captured.length).toBe(1);
      expect(captured[0]).toContain('klingon');
      expect(captured[0]).toContain('ZELARI_RESPONSE_LANG');
    } finally {
      delete (globalThis as any).__zelariLangWarnSink;
    }
  });

  it('detects when ZELARI_RESPONSE_LANG is unset', () => {
    expect(resolveResponseLanguage('Hello world, please help me', {})).toBe('en');
  });
});

describe('buildLanguageDirective', () => {
  it('names the target language in plain prose', () => {
    const itDir = buildLanguageDirective('it');
    expect(itDir).toContain('Italian');
    expect(itDir.toLowerCase()).toContain('reply in italian');

    const enDir = buildLanguageDirective('en');
    expect(enDir).toContain('English');
  });

  it('covers all three dispatch modes in the directive', () => {
    const dir = buildLanguageDirective('it');
    // Should mention single, council, zelari so the directive is universal.
    expect(dir.toLowerCase()).toContain('council');
    expect(dir.toLowerCase()).toContain('zelari');
    expect(dir.toLowerCase()).toContain('single');
  });

  it('mentions the clarifying-question format (---QUESTION---)', () => {
    // The picker UI renders the question; it must be in the target language.
    const dir = buildLanguageDirective('en');
    expect(dir).toContain('---QUESTION---');
  });
});

describe('buildLanguagePolicyModule', () => {
  it('produces a SystemPromptModule with priority 5 (before base-identity 10)', () => {
    const mod = buildLanguagePolicyModule('it');
    expect(mod.priority).toBe(5);
    // v1.7.0: type is 'language-policy', NOT 'custom'. Using 'custom' here
    // would silently drop 5 critical base directives (Structured Reasoning,
    // Collaboration, Tool-Use Protocol, Output Quality, Clarification
    // Protocol) — all of which are themselves typed 'custom'. The override
    // filter in systemPromptBuilder.ts:164 removes base modules of the
    // same type as ANY custom module. See the v1.7.0 fresh-eyes audit.
    expect(mod.type).toBe('language-policy');
  });

  it('uses a stable module type so callers can detect / override', () => {
    expect(LANGUAGE_POLICY_MODULE_TYPE).toBe('language-policy');
    // The module type itself stays a dedicated slot so the override-replacement
    // path (baseModules.filter(m => !customTypes.has(m.type))) does NOT drop
    // any base directive. Consumers can identify the module by the
    // LANGUAGE_POLICY_MODULE_TYPE constant.
    const mod = buildLanguagePolicyModule('en');
    expect(mod.type).toBe('language-policy');
    expect(mod.title).toContain('English');
  });
});

describe('buildLanguagePolicyModuleFor', () => {
  it('combines detection + module build in one call', () => {
    const itMod = buildLanguagePolicyModuleFor('Per favore fai questa cosa', {});
    expect(itMod.title).toContain('Italian');

    const enMod = buildLanguagePolicyModuleFor('Please do this thing', {});
    expect(enMod.title).toContain('English');
  });

  it('honors ZELARI_RESPONSE_LANG when constructing the module', () => {
    const mod = buildLanguagePolicyModuleFor('Hello world', { ZELARI_RESPONSE_LANG: 'fr' });
    expect(mod.title).toContain('French');
  });
});