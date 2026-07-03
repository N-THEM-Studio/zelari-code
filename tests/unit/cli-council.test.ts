import { describe, it, expect } from 'vitest';
import { handleSlashCommand, type SlashCommandResult } from '../../src/cli/slashCommands.js';
import { dispatchCouncil, CouncilDispatchError } from '../../src/cli/councilDispatcher.js';
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { BrainEvent } from '@zelari/core/events';

describe('slashCommands /council', () => {
  it('/council without args returns usage message', () => {
    const result: SlashCommandResult = handleSlashCommand('/council', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('council');
    expect(result.message).toMatch(/Usage/i);
    expect(result.councilInput).toBeUndefined();
  });

  it('/council <input> returns handled with the input string', () => {
    const result: SlashCommandResult = handleSlashCommand('/council refactor the auth module', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('council');
    expect(result.councilInput).toBe('refactor the auth module');
  });

  it('/council with empty whitespace input is treated as no input', () => {
    const result: SlashCommandResult = handleSlashCommand('/council    ', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('council');
    expect(result.councilInput).toBeUndefined();
    expect(result.message).toMatch(/Usage/i);
  });

  it('/help lists /council in available commands', () => {
    const result: SlashCommandResult = handleSlashCommand('/help', []);
    expect(result.handled).toBe(true);
    expect(result.message).toMatch(/\/council/);
  });
});

describe('councilDispatcher', () => {
  function makeStream(deltas: Array<{ kind: string; [k: string]: unknown }>): ProviderStreamFn {
    return async function* () {
      for (const d of deltas) {
        yield d as never;
      }
    };
  }

  /** Drain an async iterable into an array (preserves throw semantics). */
  async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
  }

  it('throws CouncilDispatchError when apiKey is empty', async () => {
    const stream = makeStream([{ kind: 'text', delta: 'hi' }]);
    await expect(collect(dispatchCouncil('hello', {
      apiKey: '',
      model: 'grok-4',
      providerStream: stream,
    }))).rejects.toThrow(CouncilDispatchError);
  });

  it('throws CouncilDispatchError when userMessage is empty', async () => {
    const stream = makeStream([{ kind: 'text', delta: 'hi' }]);
    await expect(collect(dispatchCouncil('   ', {
      apiKey: 'sk-test',
      model: 'grok-4',
      providerStream: stream,
    }))).rejects.toThrow(CouncilDispatchError);
  });

  it('yields events from runCouncilPure with the supplied provider stream', async () => {
    const stream: ProviderStreamFn = async function* () {
      yield { kind: 'text', delta: 'reply-1' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const events: BrainEvent[] = [];
    for await (const e of dispatchCouncil('hello', {
      apiKey: 'sk-test',
      model: 'test-model',
      provider: 'openai-compatible',
      councilSize: 1,
      debateMode: false,
      providerStream: stream,
    })) {
      events.push(e);
    }
    // Expect at least the agent_start + agent_end cycle from the council.
    const types = events.map((e) => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('agent_end');
  });

  it('uses provided sessionId when supplied', async () => {
      const stream: ProviderStreamFn = async function* () {
        yield { kind: 'text', delta: 'x' };
        yield { kind: 'finish', reason: 'stop' };
      };
      const events: BrainEvent[] = [];
      for await (const e of dispatchCouncil('hello', {
        apiKey: 'k',
        model: 'test-model',
        sessionId: 'sess-fixed-123',
        providerStream: stream,
      })) {
        events.push(e);
      }
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.sessionId).toBe('sess-fixed-123');
      }
    });

    it('runs Minosse even when debateMode is false (v0.7.5 Bug C fix)', async () => {
      // Bug C fix: the Minosse (oracle / critic) review block was gated on
      // config.debateMode. Default debateMode is false, so a 6-member council
      // (councilSize=6) silently ran only 5 members. Users saw a
      // member_cost event for Minosse but no actual agent_start/message_end.
      //
      // After the fix: Minosse always runs once before Lucifero (the
      // multi-round debate loop remains debateMode-gated, but a single
      // review pass is always useful before final synthesis).
      const seenMembers = new Set<string>();
      const stream: ProviderStreamFn = async function* () {
        yield { kind: 'text', delta: 'x' };
        yield { kind: 'finish', reason: 'stop' };
      };
      for await (const e of dispatchCouncil('plan a release', {
        apiKey: 'k',
        model: 'm',
        provider: 'openai-compatible',
        councilSize: 6,
        debateMode: false, // ← the critical flag
        providerStream: stream,
      })) {
        if (e.type === 'agent_start') {
          const memberName = (e as BrainEvent & { memberName?: string }).memberName;
          if (memberName) seenMembers.add(memberName);
        }
      }
      // 6-member council must include Minosse (the critic) even in non-debate mode.
      expect(seenMembers.has('Minosse')).toBe(true);
      // Sanity: the chairman (Lucifero) still runs.
      expect(seenMembers.has('Lucifero')).toBe(true);
    });
  });