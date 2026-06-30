import { describe, it, expect } from 'vitest';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

describe('slashCommands /branch + /branches + /checkout (Task 17.2)', () => {
  describe('/branch', () => {
    it('/branch without args returns branch_create with usage hint', () => {
      const result = handleSlashCommand('/branch', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('branch_create');
      expect(result.message).toMatch(/Usage/i);
      expect(result.branchName).toBeUndefined();
    });

    it('/branch <name> returns branch_create + branchName', () => {
      const result = handleSlashCommand('/branch experiment-x', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('branch_create');
      expect(result.branchName).toBe('experiment-x');
    });

    it('/branch with extra args ignores them (only first word is branchName)', () => {
      // Branch names should not contain spaces (filesystem-safe), so we only take args[0].
      const result = handleSlashCommand('/branch my-experiment extra-args ignored', []);
      expect(result.branchName).toBe('my-experiment');
    });
  });

  describe('/branches', () => {
    it('/branches returns branch_list with no args', () => {
      const result = handleSlashCommand('/branches', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('branch_list');
      expect(result.branchName).toBeUndefined();
    });

    it('/branches ignores extra args', () => {
      const result = handleSlashCommand('/branches extra-arg ignored', []);
      expect(result.kind).toBe('branch_list');
    });
  });

  describe('/checkout', () => {
    it('/checkout without args returns branch_checkout with usage hint', () => {
      const result = handleSlashCommand('/checkout', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('branch_checkout');
      expect(result.message).toMatch(/Usage/i);
      expect(result.branchName).toBeUndefined();
    });

    it('/checkout <name> returns branch_checkout + branchName', () => {
      const result = handleSlashCommand('/checkout experiment-x', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('branch_checkout');
      expect(result.branchName).toBe('experiment-x');
    });
  });

  describe('discrimination', () => {
    it('branch commands distinct from provider/skill/council', () => {
      const a = handleSlashCommand('/branch foo', []);
      const b = handleSlashCommand('/branches', []);
      const c = handleSlashCommand('/checkout foo', []);
      const d = handleSlashCommand('/provider grok', []);
      expect(a.kind).toBe('branch_create');
      expect(b.kind).toBe('branch_list');
      expect(c.kind).toBe('branch_checkout');
      expect(d.kind).toBe('provider_set');
    });
  });
});