/**
 * core-textLoopDetect + AgentHarness assistant_text_loop guard.
 */
import { describe, it, expect } from 'vitest';
import {
  AgentHarness,
  detectAssistantTextLoop,
  collapseLoopedAssistantText,
  normalizeLoopUnit,
  type ProviderStreamFn,
  type ProviderDelta,
} from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/events';

async function collect(stream: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const DIAGNOSIS = [
  'Diagnosi fatta. Procedo coi 4 fix.',
  '',
  'Root cause: initHUD crea 4 celle con data-skill="", poi updateHUD tenta SKILLS[""].tag[0] → crash. Nessun codice popola data-skill. start() chiama initHUD due volte.',
  '',
  'Procedo coi 4 fix.',
].join('\n');

describe('detectAssistantTextLoop', () => {
  it('returns false for normal short prose', () => {
    expect(
      detectAssistantTextLoop('Here is a normal answer with one diagnosis only.'),
    ).toEqual({ looping: false });
  });

  it('detects repeated blank-line-separated paragraphs', () => {
    const unit = DIAGNOSIS;
    const text = [unit, unit, unit, unit].join('\n\n');
    const hit = detectAssistantTextLoop(text);
    expect(hit.looping).toBe(true);
    if (hit.looping) {
      expect(hit.kind).toBe('paragraph');
      expect(hit.count).toBeGreaterThanOrEqual(3);
      expect(normalizeLoopUnit(hit.unit)).toContain('initHUD');
    }
  });

  it('detects repeated paragraphs wrapped in <small>', () => {
    const unit = `<small>${DIAGNOSIS}</small>`;
    const text = [unit, unit, unit].join('\n\n');
    const hit = detectAssistantTextLoop(text);
    expect(hit.looping).toBe(true);
  });

  it('detects repeated full lines', () => {
    const line =
      'Diagnosi fatta. Procedo coi 4 fix. Root cause: initHUD data-skill empty causes SKILLS crash on updateHUD.';
    const text = [line, line, line, line].join('\n');
    const hit = detectAssistantTextLoop(text);
    expect(hit.looping).toBe(true);
    if (hit.looping) expect(hit.kind).toBe('line');
  });

  it('detects continuous suffix cycles without blank lines', () => {
    const unit =
      'Diagnosi fatta. Procedo coi 4 fix. Root cause initHUD data-skill empty SKILLS crash. ';
    const text = unit.repeat(5);
    const hit = detectAssistantTextLoop(text);
    expect(hit.looping).toBe(true);
  });

  it('does not flag three short identical words', () => {
    expect(detectAssistantTextLoop('ok\n\nok\n\nok')).toEqual({ looping: false });
  });
});

describe('collapseLoopedAssistantText', () => {
  it('keeps early content and drops extra trailing repeats', () => {
    const unit = DIAGNOSIS;
    const text = [unit, unit, unit, unit, unit].join('\n\n');
    const collapsed = collapseLoopedAssistantText(text);
    expect(collapsed.length).toBeLessThan(text.length);
    expect(collapsed).toMatch(/stopped repeating/i);
    // Still contains the diagnosis once
    expect(collapsed).toContain('initHUD');
  });
});

describe('AgentHarness — assistant_text_loop early stop', () => {
  it('stops mid-stream when the model repeats the same block', async () => {
    const unit = DIAGNOSIS + '\n\n';
    // Stream many full units as separate deltas (simulates provider chunks).
    const deltas: ProviderDelta[] = [];
    for (let i = 0; i < 12; i++) {
      deltas.push({ kind: 'text', delta: unit });
    }
    deltas.push({ kind: 'finish', reason: 'stop' });

    let yielded = 0;
    const provider: ProviderStreamFn = async function* () {
      for (const d of deltas) {
        yielded++;
        yield d;
      }
    };

    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-text-loop',
      messages: [{ role: 'user', content: 'fix the HUD bug' }],
      tools: [],
      providerStream: provider,
    });

    const events = await collect(harness.run());
    const loopErr = events.find(
      (e) => e.type === 'error' && (e as { code?: string }).code === 'assistant_text_loop',
    );
    expect(loopErr).toBeTruthy();
    expect((loopErr as { severity: string }).severity).toBe('recoverable');

    const agentEnd = events.find((e) => e.type === 'agent_end');
    expect(agentEnd && (agentEnd as { reason: string }).reason).toBe('completed');

    // Provider should not have been fully drained (break before all 12 units + finish).
    // Allow some slack: detection needs ≥3 units; we must stop well before 12.
    expect(yielded).toBeLessThan(deltas.length);

    // Assistant message sealed (collapsed) on the transcript
    const msgs = harness.getMessages();
    const asst = [...msgs].reverse().find((m) => m.role === 'assistant');
    expect(asst).toBeTruthy();
    expect((asst!.content ?? '').length).toBeGreaterThan(0);
  });

  it('does not fire on a normal single-paragraph answer', async () => {
    const provider: ProviderStreamFn = async function* () {
      yield {
        kind: 'text',
        delta:
          'I fixed initHUD to set data-skill from the SKILLS map and removed the double initHUD call in start().',
      };
      yield { kind: 'finish', reason: 'stop' };
    };

    const harness = new AgentHarness({
      model: 'm',
      provider: 'p',
      sessionId: 's-text-ok',
      messages: [{ role: 'user', content: 'fix it' }],
      tools: [],
      providerStream: provider,
    });

    const events = await collect(harness.run());
    const loopErr = events.find(
      (e) => e.type === 'error' && (e as { code?: string }).code === 'assistant_text_loop',
    );
    expect(loopErr).toBeUndefined();
    const text = events
      .filter((e) => e.type === 'message_delta')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(text).toContain('initHUD');
  });
});
