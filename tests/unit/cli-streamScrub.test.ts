/**
 * streamScrub — regression tests for the headless stream scrubber.
 *
 * The original bug (v1.10.0): in a tool-loop turn the harness emits multiple
 * `message_start` → `message_delta*` → `message_end` cycles (one per assistant
 * turn). The scrubber used to accumulate raw text across ALL messages with a
 * single buffer, so an unclosed `<think>` in an early message made the
 * trailing-block regex eat ALL subsequent text across later messages —
 * legitimate prose between tool calls got trapped and never emitted.
 *
 * @since v1.10.0
 */
import { describe, expect, it } from 'vitest';
import { createStreamScrubber } from '../../src/cli/utils/streamScrub.js';

describe('createStreamScrubber', () => {
  it('strips a complete <think> block', () => {
    const s = createStreamScrubber();
    const out = s.push('<think>secret</think>visible text');
    expect(out).toBe('visible text');
  });

  it('strips a think block split across multiple deltas', () => {
    const s = createStreamScrubber();
    const a = s.push('hello <think>');
    const b = s.push('reasoning');
    const c = s.push('</think> world');
    // cleanAgentContent leaves a space on each side of the removed block;
    // collapse whitespace for the assertion.
    expect((a + b + c).replace(/\s+/g, ' ').trim()).toBe('hello world');
  });

  it('strips orphan </think> closing tags', () => {
    const s = createStreamScrubber();
    const out = s.push('text </think> more text');
    expect(out.replace(/\s+/g, ' ').trim()).toBe('text more text');
  });

  it('strips ---QUESTION--- blocks by default', () => {
    const s = createStreamScrubber();
    const out = s.push('before ---QUESTION---{"q":"x"}---END--- after');
    expect(out.replace(/\s+/g, ' ').trim()).toBe('before after');
  });

  // === THE REGRESSION: text trapped across messages ===
  it('emits text from a LATER message even if an earlier one had an unclosed <think>', () => {
    // Simulates a tool-loop turn:
    //   message 1: assistant emits <think> (never closes) then tool_call
    //   message 2: assistant emits legit final text
    const s = createStreamScrubber();

    // Message 1: unclosed think + some content. Without reset(), the
    // trailing-block regex eats everything and push() returns ''.
    const m1 = s.push('<think>planning the edit');
    // Without the bug fix, m1 would be '' AND the buffer stays poisoned.
    expect(m1).toBe('');

    // RESET — this is what runHeadless now does on every message_start.
    s.reset();

    // Message 2: legit final text. Pre-fix this was swallowed by the
    // leftover unclosed <think> in the buffer. Post-fix it emits normally.
    const m2 = s.push('Done! All files updated.');
    expect(m2).toBe('Done! All files updated.');
  });

  it('reset() clears state so the next message is scrubbed independently', () => {
    const s = createStreamScrubber();
    s.push('first message text');
    s.reset();
    // After reset, internal emittedLen is 0, so a fresh push returns fully.
    const out = s.push('second message');
    expect(out).toBe('second message');
  });

  it('flush() returns remaining clean text at end of turn', () => {
    const s = createStreamScrubber();
    s.reset();
    s.push('hello');
    // No trailing unclosed tag → flush returns nothing new (already emitted).
    expect(s.flush()).toBe('');
  });
});
