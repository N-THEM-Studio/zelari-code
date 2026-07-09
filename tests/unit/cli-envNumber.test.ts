/**
 * Tests for envNumber — the centralized env-var parser that replaces the
 * duplicated `Number.parseInt + isFinite > 0` pattern scattered across
 * useChatTurn, runHeadless, historyCompaction, councilConfig, slashCommands,
 * zelariMission, and the provider retry logic.
 *
 * Pins every branch so a future "simplification" can't silently flip a NaN
 * to a thrown exception or a 0 to the default without a test failing.
 */
import { describe, it, expect } from 'vitest';
import { envNumber } from '../../src/cli/utils/envNumber.js';

describe('envNumber', () => {
  describe('unset / empty', () => {
    it('returns default when raw is undefined', () => {
      expect(envNumber(undefined, { default: 25 })).toBe(25);
    });

    it('returns default when raw is null', () => {
      expect(envNumber(null, { default: 25 })).toBe(25);
    });

    it('returns default when raw is empty string', () => {
      expect(envNumber('', { default: 25 })).toBe(25);
    });

    it('returns default when raw is whitespace-only', () => {
      expect(envNumber('   ', { default: 25 })).toBe(25);
    });

    it('returns default for the literal "undefined" token (JSON.stringify leak)', () => {
      expect(envNumber('undefined', { default: 25 })).toBe(25);
    });

    it('returns default for the literal "null" token', () => {
      expect(envNumber('null', { default: 25 })).toBe(25);
    });
  });

  describe('parsing', () => {
    it('parses positive integers', () => {
      expect(envNumber('30', { default: 25 })).toBe(30);
      expect(envNumber('90', { default: 25 })).toBe(90);
      expect(envNumber('1', { default: 25 })).toBe(1);
    });

    it('parses zero when min permits it', () => {
      expect(envNumber('0', { default: 25, min: 0 })).toBe(0);
    });

    it('parses negative integers when min permits them', () => {
      expect(envNumber('-5', { default: 0, min: -10 })).toBe(-5);
    });

    it('strips leading whitespace before parsing', () => {
      expect(envNumber('  42  ', { default: 25 })).toBe(42);
    });
  });

  describe('garbage input → default', () => {
    it('rejects non-numeric strings', () => {
      expect(envNumber('abc', { default: 25 })).toBe(25);
    });

    it('rejects partial parses (e.g. "30x" — parseInt would silently return 30)', () => {
      // parseInt("30x", 10) === 30 in JavaScript, but the trailing "x"
      // means the input was malformed. Centralizing here rejects it.
      expect(envNumber('30x', { default: 25 })).toBe(25);
    });

    it('rejects floats (parseInt would truncate "30.5" → 30)', () => {
      expect(envNumber('30.5', { default: 25 })).toBe(25);
    });

    it('rejects scientific notation', () => {
      expect(envNumber('1e3', { default: 25 })).toBe(25);
    });

    it('rejects double-sign input ("--30")', () => {
      // parseInt("--30", 10) === -30 (it parses "-30" from the suffix).
      // The input syntax is bogus though, so we reject it.
      expect(envNumber('--30', { default: 25 })).toBe(25);
    });

    it('rejects unicode minus "−30" (U+2212, not ASCII U+002D)', () => {
      // Common copy-paste from chat: the user types a real minus sign
      // (often rendered by chat apps as U+2212) but our env-var contract
      // is ASCII-only. parseInt sees NaN for this input — explicit
      // assertion here so a future "support unicode minus" change is
      // intentional, not accidental.
      expect(envNumber('−30', { default: 25 })).toBe(25);
    });
  });

  describe('v1.7.0 — accepted input forms (agy audit)', () => {
    // Agy flagged that the original round-trip check rejected inputs that
    // legitimate shell scripts DO emit. These tests pin the now-accepted
    // forms so a regression to "round-trip exact match" surfaces immediately.

    it('accepts leading "+" sign ("+30" → 30)', () => {
      expect(envNumber('+30', { default: 25 })).toBe(30);
    });

    it('accepts leading zeros ("0030" → 30)', () => {
      // parseInt("0030", 10) === 30 (decimal radix, no octal surprise).
      expect(envNumber('0030', { default: 25 })).toBe(30);
    });

    it('accepts negative with leading zeros ("-030" → -30)', () => {
      expect(envNumber('-030', { default: 0, min: -100 })).toBe(-30);
    });

    it('accepts negative plain ("-5" → -5)', () => {
      expect(envNumber('-5', { default: 0, min: -10 })).toBe(-5);
    });

    it('accepts explicit positive ("+0" → 0)', () => {
      expect(envNumber('+0', { default: 25, min: 0 })).toBe(0);
    });
  });

  describe('bounds', () => {
    it('clamps to min when below', () => {
      expect(envNumber('0', { default: 25, min: 1 })).toBe(1);
      expect(envNumber('-100', { default: 25, min: 0 })).toBe(0);
    });

    it('clamps to max when above', () => {
      expect(envNumber('999', { default: 25, max: 100 })).toBe(100);
    });

    it('clamps both bounds in the same call', () => {
      expect(envNumber('50', { default: 25, min: 10, max: 100 })).toBe(50);
      expect(envNumber('5', { default: 25, min: 10, max: 100 })).toBe(10);
      expect(envNumber('500', { default: 25, min: 10, max: 100 })).toBe(100);
    });

    it('min defaults to 0 (no clamping when value is positive)', () => {
      expect(envNumber('5', { default: 25 })).toBe(5);
    });
  });

  describe('regression — pre-centralization call sites', () => {
    // Pins each of the existing env-var names so a change to defaults / min
    // surfaces as a test failure here, not a runtime NaN.

    it('ZELARI_MAX_TOOL_CALLS (default 25, min 1)', () => {
      expect(envNumber(undefined, { default: 25, min: 1 })).toBe(25);
      expect(envNumber('abc', { default: 25, min: 1 })).toBe(25);
      expect(envNumber('0', { default: 25, min: 1 })).toBe(1); // min clamps
    });

    it('ZELARI_MAX_TOOL_LOOP_ITERATIONS (default 90, min 1)', () => {
      expect(envNumber(undefined, { default: 90, min: 1 })).toBe(90);
      expect(envNumber('0', { default: 90, min: 1 })).toBe(1);
    });

    it('ZELARI_PROVIDER_MAX_RETRIES (default 3, min 0)', () => {
      expect(envNumber(undefined, { default: 3, min: 0 })).toBe(3);
      expect(envNumber('0', { default: 3, min: 0 })).toBe(0); // 0 means "no retry"
    });

    it('ZELARI_HISTORY_TURNS (default 6, min 0)', () => {
      expect(envNumber(undefined, { default: 6, min: 0 })).toBe(6);
      expect(envNumber('0', { default: 6, min: 0 })).toBe(0); // 0 disables history
    });
  });
});