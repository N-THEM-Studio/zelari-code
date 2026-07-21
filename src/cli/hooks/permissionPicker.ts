/**
 * Build an interactive permission-ask handler from the TUI picker.
 * Choices: Allow once · Allow always (tool) · Allow always (category) · Deny.
 *
 * @since v1.21.0
 */
import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';
import {
  grantSessionCategory,
  grantSessionTool,
  type PermissionAskHandler,
} from '../safety/toolPermissions.js';
import type { PickerRequest } from '../slashHandlers/provider.js';

export type SetPicker = (req: PickerRequest | null) => void;

export type AppendSystem = (
  msg: string,
  createdAt?: number,
) => void;

/**
 * Interactive permission handler for TUI. Returns true if allowed.
 */
export function createPermissionAskHandler(opts: {
  setPicker: SetPicker;
  appendSystem?: AppendSystem;
}): PermissionAskHandler {
  const { setPicker, appendSystem } = opts;
  return (req) =>
    new Promise<boolean>((resolve) => {
      const cats = req.categories;
      const catLabel = cats.length === 1 ? cats[0] : cats.join('+') || 'action';
      const title = `Allow tool "${req.toolName}"?`;
      const detail =
        req.reason +
        (cats.length ? ` [${cats.join(', ')}]` : '');
      appendSystem?.(
        `[permission] ${title}\n${detail}\n→ Allow once · Always (tool) · Always (${catLabel}) · Deny`,
        Date.now(),
      );
      let settled = false;
      const finish = (ok: boolean, note?: string) => {
        if (settled) return;
        settled = true;
        setPicker(null);
        if (note) appendSystem?.(note, Date.now());
        resolve(ok);
      };

      const items: Array<{ value: string; label: string }> = [
        { value: 'allow', label: 'Allow once' },
        {
          value: 'always-tool',
          label: `Allow always this session · tool ${req.toolName}`,
        },
      ];
      if (cats.length > 0) {
        items.push({
          value: 'always-cat',
          label: `Allow always this session · ${catLabel}`,
        });
      }
      items.push({ value: 'deny', label: 'Deny' });

      setPicker({
        kind: 'clarification',
        title,
        items,
        onAnswer: (value: string) => {
          const v = value.trim().toLowerCase();
          if (v === 'deny' || v.startsWith('deny')) {
            finish(false);
            return;
          }
          if (v === 'always-tool' || v.includes('always') && v.includes('tool')) {
            grantSessionTool(req.toolName);
            finish(
              true,
              `[permission] Granted "${req.toolName}" for this session (tool).`,
            );
            return;
          }
          if (v === 'always-cat' || (v.includes('always') && !v.includes('tool'))) {
            for (const c of cats) grantSessionCategory(c as ToolPermission);
            // Also grant the tool so mixed-permission tools work after category grant.
            grantSessionTool(req.toolName);
            finish(
              true,
              `[permission] Granted ${catLabel} (+ ${req.toolName}) for this session.`,
            );
            return;
          }
          // allow once (default for "allow" / free-text yes)
          if (
            v === 'allow' ||
            v.startsWith('allow') ||
            v === 'yes' ||
            v === 'y' ||
            v === '1'
          ) {
            finish(true);
            return;
          }
          finish(false);
        },
        onCancel: () => finish(false),
      });
    });
}
