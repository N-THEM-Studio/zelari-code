import { describe, it, expect } from 'vitest';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

describe('slashCommands /workspace (v3-W)', () => {
  describe('help / default', () => {
    it('/workspace without args returns workspace kind with usage hint', () => {
      const result = handleSlashCommand('/workspace', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('workspace');
      expect(result.message).toMatch(/workspace show/i);
    });

    it('/workspace --help is equivalent to bare /workspace', () => {
      const result = handleSlashCommand('/workspace --help', []);
      expect(result.kind).toBe('workspace');
      expect(result.message).toMatch(/workspace show/i);
    });

    it('/workspace help is equivalent to --help', () => {
      const result = handleSlashCommand('/workspace help', []);
      expect(result.kind).toBe('workspace');
    });
  });

  describe('/workspace show', () => {
    it('/workspace show without <what> returns usage hint', () => {
      const result = handleSlashCommand('/workspace show', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('workspace_show');
      expect(result.workspaceWhat).toBe('');
      expect(result.message).toMatch(/Usage/i);
    });

    it('/workspace show plan returns workspace_show with what=plan', () => {
      const result = handleSlashCommand('/workspace show plan', []);
      expect(result.kind).toBe('workspace_show');
      expect(result.workspaceWhat).toBe('plan');
    });

    it('/workspace show decisions returns workspace_show with what=decisions', () => {
      const result = handleSlashCommand('/workspace show decisions', []);
      expect(result.kind).toBe('workspace_show');
      expect(result.workspaceWhat).toBe('decisions');
    });

    it('/workspace show risks returns workspace_show with what=risks', () => {
      const result = handleSlashCommand('/workspace show risks', []);
      expect(result.workspaceWhat).toBe('risks');
    });

    it('/workspace show agents returns workspace_show with what=agents', () => {
      const result = handleSlashCommand('/workspace show agents', []);
      expect(result.workspaceWhat).toBe('agents');
    });

    it('/workspace show docs returns workspace_show with what=docs', () => {
      const result = handleSlashCommand('/workspace show docs', []);
      expect(result.workspaceWhat).toBe('docs');
    });

    it('/workspace show with unknown artifact returns usage hint', () => {
      const result = handleSlashCommand('/workspace show banana', []);
      expect(result.kind).toBe('workspace_show');
      expect(result.workspaceWhat).toBe('');
      expect(result.message).toMatch(/Unknown artifact/i);
    });
  });

  describe('/workspace sync', () => {
    it('/workspace sync returns workspace_sync with no payload', () => {
      const result = handleSlashCommand('/workspace sync', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('workspace_sync');
    });
  });

  describe('/workspace reset', () => {
    it('/workspace reset without --yes returns destructive warning', () => {
      const result = handleSlashCommand('/workspace reset', []);
      expect(result.kind).toBe('workspace_reset');
      expect(result.workspaceForce).toBeUndefined();
      expect(result.message).toMatch(/DESTRUCTIVE/i);
    });

    it('/workspace reset --yes confirms and sets workspaceForce', () => {
      const result = handleSlashCommand('/workspace reset --yes', []);
      expect(result.kind).toBe('workspace_reset');
      expect(result.workspaceForce).toBe(true);
    });

    it('/workspace reset -y is equivalent to --yes', () => {
      const result = handleSlashCommand('/workspace reset -y', []);
      expect(result.workspaceForce).toBe(true);
    });
  });

  describe('discrimination', () => {
    it('/workspace commands do not collide with other commands', () => {
      expect(handleSlashCommand('/workspace', []).kind).toBe('workspace');
      expect(handleSlashCommand('/help', []).kind).toBe('help');
      expect(handleSlashCommand('/council foo', []).kind).toBe('council');
    });

    it('unknown /workspace subcommand falls back to workspace with error message', () => {
      const result = handleSlashCommand('/workspace banana', []);
      expect(result.kind).toBe('workspace');
      expect(result.message).toMatch(/Unknown.*subcommand/i);
    });
  });
});