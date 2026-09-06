import { describe, expect, it } from 'vitest';
import {
  createServeAskUserBridge,
  serveAskUserRespond,
} from '../../src/cli/serve/askUserBridge.js';

describe('createServeAskUserBridge', () => {
  it('emits ask_user.request and resolves on respond', async () => {
    const lines: string[] = [];
    const bridge = createServeAskUserBridge((l) => lines.push(l), 60_000);
    const pending = bridge.onAskUser({
      question: 'Which scope?',
      choices: ['Minimal', 'Full'],
    });
    expect(bridge.pendingCount()).toBe(1);
    const event = JSON.parse(lines[0]!) as {
      type: string;
      requestId: string;
      question: string;
      choices: string[];
    };
    expect(event.type).toBe('ask_user.request');
    expect(event.question).toBe('Which scope?');
    expect(event.choices).toEqual(['Minimal', 'Full']);
    expect(bridge.respond(event.requestId, 'Full')).toBe(true);
    await expect(pending).resolves.toBe('Full');
    const settled = JSON.parse(lines[1]!) as { type: string; answer: string };
    expect(settled.type).toBe('ask_user.settled');
    expect(settled.answer).toBe('Full');
  });

  it('times out to null (assumption path, not deny)', async () => {
    const bridge = createServeAskUserBridge(() => {}, 10);
    const pending = bridge.onAskUser({
      question: 'Pick',
      choices: ['A', 'B'],
    });
    await expect(pending).resolves.toBeNull();
    expect(bridge.pendingCount()).toBe(0);
  });
});

describe('serveAskUserRespond', () => {
  it('validates params and is idempotent for unknown ids', () => {
    const bridge = createServeAskUserBridge(() => {}, 60_000);
    expect(serveAskUserRespond(bridge, null).accepted).toBe(false);
    expect(serveAskUserRespond(bridge, { requestId: 'x', answer: 1 }).accepted).toBe(
      false,
    );
    expect(
      serveAskUserRespond(bridge, { requestId: 'ghost', answer: 'hi' }).accepted,
    ).toBe(false);
  });
});
