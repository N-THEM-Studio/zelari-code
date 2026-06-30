import { describe, it, expect } from 'vitest';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

describe('slashCommands /steer (Task 18.2)', () => {
  describe('/steer', () => {
    it('/steer without args returns steer kind with a usage hint', () => {
      const result = handleSlashCommand('/steer', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('steer');
      expect(result.message).toMatch(/Usage/i);
      expect(result.steerText).toBeUndefined();
    });

    it('/steer <text> returns steer kind with steerText set to the joined args', () => {
      const result = handleSlashCommand('/steer continue with the next refactor', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('steer');
      expect(result.steerText).toBe('continue with the next refactor');
    });

    it('/steer with leading/trailing whitespace is trimmed', () => {
      // Note: parseSlashCommand splits on /\s+/, so internal multiple
      // spaces collapse to single spaces. Only the leading/trailing
      // trim is observed here.
      const result = handleSlashCommand('/steer   multi word prompt  ', []);
      expect(result.steerText).toBe('multi word prompt');
    });
  });

  describe('help message lists /steer', () => {
    it('help text mentions /steer', () => {
      const result = handleSlashCommand('/help', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('help');
      expect(result.message).toMatch(/\/steer/);
    });
  });
});