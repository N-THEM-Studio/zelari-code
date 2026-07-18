/**
 * Skill: when / how to use Cua Driver (trycua) for desktop computer-use.
 * Tools come from MCP (`mcp_cua-driver_*`) after `zelari-code --set-mcp-preset cua`.
 */
import type { CodingSkillDefinition } from '../../skills.js';
import { registerCodingSkill } from '../../skills.js';

const computerUseCua: CodingSkillDefinition = {
  id: 'computer-use-cua',
  version: '1.0.0',
  name: 'Desktop computer-use (Cua Driver)',
  description:
    'Drive native desktop apps in the background via Cua Driver MCP — click, type, snapshot windows without stealing focus. Prefer shell/file tools for coding; use Cua only for real GUI apps.',
  category: 'debug',
  requiredRoles: [],
  requiredTools: [],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Click through a native desktop installer or Electron settings UI',
    'Verify a GUI app that is not a web page in Chromium',
    'Accessibility / window-level automation on the host OS',
    'Background computer-use without moving the user cursor',
  ],
  antiPatterns: [
    'Pure coding / file edits / tests — use write_file, edit_file, bash',
    'Web page checks — use browser_check (Playwright) first',
    'Running Cua for every council specialist (saturates context)',
    'Assuming Cua is installed — check tools or ask user to run doctor',
  ],
  requires: [],
  relatedSkills: ['debug-with-rag'],
  tags: ['cua', 'computer-use', 'desktop', 'mcp', 'gui'],
  examples: [
    {
      input: 'Open the app settings window and enable dark mode',
      output: {
        approach:
          'If mcp_cua-driver_* tools are available: list windows → snapshot target → click/type. If not: tell user to install cua-driver and run zelari-code --set-mcp-preset cua. Prefer product file config if dark mode is a setting in JSON/code.',
      },
    },
  ],
  outputSchema:
    '{ usedCua: boolean; windows?: string[]; actions: string[]; verifiedOnDisk?: boolean }',
  systemPromptFragment: `# Desktop computer-use (Cua Driver)

## When to use
- Native / Electron **desktop** UI that cannot be verified with \`browser_check\` or file edits.
- Background control (no focus steal) via MCP tools named like \`mcp_cua-driver_*\`.

## When NOT to use
- Source edits, tests, git, package install → normal coding tools.
- Web UIs → \`browser_check\` / Playwright.
- Full 6-member council by default: Cua tools are **not** registered for council specialists unless \`ZELARI_CUA_COUNCIL=1\`. Prefer agent mode or Lucifero implementer.

## Setup (user)
1. Install: https://cua.ai/docs/how-to-guides/driver/install
2. \`zelari-code --set-mcp-preset cua\`
3. \`cua-driver doctor\` (+ macOS Accessibility / Screen Recording)
4. Kill switch: \`ZELARI_CUA=0\`

## Grounding
- Prefer reading product config files over clicking UI when both work.
- After GUI actions, verify durable state on disk when possible.
- Do not invent window titles or controls — list/snapshot first.
`,
};

registerCodingSkill(computerUseCua);
