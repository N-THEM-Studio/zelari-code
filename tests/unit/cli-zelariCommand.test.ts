import { describe, it, expect } from 'vitest';
import { handleSlashCommand, type SlashCommandResult } from '../../src/cli/slashCommands.js';

describe('slashCommands /zelari', () => {
  it('/zelari without args returns usage message', () => {
    const result: SlashCommandResult = handleSlashCommand('/zelari', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('zelari');
    expect(result.message).toMatch(/Usage/i);
    expect(result.zelariInput).toBeUndefined();
  });

  it('/zelari <prompt> returns handled with the mission prompt', () => {
    const result: SlashCommandResult = handleSlashCommand(
      '/zelari costruisci un gestionale BnB',
      [],
    );
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('zelari');
    expect(result.zelariInput).toBe('costruisci un gestionale BnB');
  });

  it('/zelari with only whitespace is treated as no input', () => {
    const result: SlashCommandResult = handleSlashCommand('/zelari    ', []);
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('zelari');
    expect(result.zelariInput).toBeUndefined();
    expect(result.message).toMatch(/Usage/i);
  });
});
