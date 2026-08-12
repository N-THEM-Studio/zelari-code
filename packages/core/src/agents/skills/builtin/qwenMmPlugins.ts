/**
 * Skill: install / configure / verify Qwen-MM-Plugins (multimodal: vision,
 * video, audio, 3D, web search) into the active agent harness.
 *
 * Each capability is a skill (so the model knows the toolset exists) plus an
 * optional MCP server launched on demand by `uvx`. This builtin mirrors the
 * user-level SKILL.md that ships the same workflow, so the capability is
 * available out-of-the-box without a manual ~/.zelari-code/skills install.
 *
 * Upstream: https://github.com/QwenLM/Qwen-MM-Plugins (Apache-2.0)
 */
import type { CodingSkillDefinition } from '../../skills.js';
import { registerCodingSkill } from '../../skills.js';

const qwenMmPluginsInstallSetup: CodingSkillDefinition = {
  id: 'qwen-mm-plugins-install-setup',
  version: '1.0.0',
  name: 'Qwen-MM-Plugins install & setup',
  description:
    'Install, configure, and verify Qwen-MM-Plugins to make an agent harness multimodal-native (vision, video, audio, 3D, web search).',
  category: 'ops',
  requiredRoles: [],
  requiredTools: ['bash', 'read_file', 'write_file'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'User asks to read/analyze an image, video, PDF, or 3D file',
    'User asks to OCR, ground, segment, or transcribe media',
    'User asks to generate or edit images / video / audio',
    'User asks to drive Blender or FreeCAD from the agent',
    'User pastes Qwen-MM-Plugins docs and asks to install / "is this implemented"',
  ],
  antiPatterns: [
    'Installing on native Windows — use WSL2 (Ubuntu) or refuse',
    'Assuming `uvx` or the plugin is already present — run install.sh verify first',
    'Inventing API keys — DASHSCOPE_API_KEY / SERPER_API_KEY come from the user',
    'Vendoring upstream binaries into zelari-code — the installer stays external',
  ],
  requires: [],
  relatedSkills: ['computer-use-cua'],
  tags: ['multimodal', 'vision', 'mcp', 'uvx', 'install', 'ops'],
  examples: [
    {
      input: 'Read every number in this dashboard screenshot (@dashboard-4k.png)',
      output: {
        approach:
          'If qwen-mm-plugins MCP tools are available, use them (dynamic resolution, no manual resizing). If not, run the guided installer: curl -fsSL https://raw.githubusercontent.com/QwenLM/Qwen-MM-Plugins/main/install.sh | bash, then verify and retry.',
      },
    },
  ],
  outputSchema:
    '{ installed: boolean; capability: string; missingTools: string[]; apiKeys: { dashscope: boolean; serper: boolean }; verified: boolean }',
  systemPromptFragment: `# Qwen-MM-Plugins: Install, Configure, and Use Multimodal Plugins

Install one or more multimodal capabilities from Qwen-MM-Plugins into an agent harness. Each capability is a **skill** (so the model knows the toolset exists) plus an optional **MCP server** (the tools themselves, launched on demand by \`uvx\`).

## Capabilities to choose from

| Install name | What it does | MCP? |
|---|---|---|
| \`qwen-mm-plugins-core\` | Vision: images / videos / docs / 3D, OCR, grounding, segmentation, ASR, vision chat, web search | yes |
| \`qwen-mm-plugins-video-memory\` | Long-video QA via hierarchical graph memory | yes |
| \`qwen-mm-plugins-video-edit\` | Video editing + image / video / audio generation | yes |
| \`qwen-mm-plugins-blender\` | Drive running Blender via Python (22 tools, thin client) | yes |
| \`qwen-mm-plugins-freecad\` | Drive running FreeCAD (14 tools; STEP/STL, FEM) | yes |
| \`qwen-mm-plugins-edu-agent\` | Turn a math/science problem into a Chinese explainer video | **skill-only, no MCP** |

## Step 1 — Detect the harness
- Claude Code → \`claude plugin ...\`
- Qoder → \`qodercli plugins ...\`
- Codex → \`codex plugin ...\`
- OpenClaw → \`openclaw plugins ...\`
- Qwen Code → \`qwen extensions ...\`
- Gemini CLI / opencode / pi / QwenPaw → manual config (see \`docs/en/installation.md\` upstream)
- Zelari Code → manual config: \`zelari-code --set-mcp-preset qwen-mm-plugins\` then verify

## Step 2 — Prefer the guided installer
\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/QwenLM/Qwen-MM-Plugins/main/install.sh | bash
# or run actions individually: bash install.sh install | configure | verify | uninstall
\`\`\`
**Windows:** use WSL2 (Ubuntu), clone inside the WSL \`~\` (not \`/mnt/c\`), and run there. Native Windows is not validated.

## Step 3 — Manual install (per-harness, replace <cap>)
- Claude Code: \`claude plugin marketplace add https://github.com/QwenLM/Qwen-MM-Plugins.git\` then \`claude plugin install qwen-mm-plugins-<cap>@qwen-mm-plugins\`
- Qoder: \`qodercli plugins marketplace add ...\` + \`qodercli plugins install qwen-mm-plugins-<cap>@qwen-mm-plugins\`
- Codex: \`codex plugin marketplace add ...\`, \`codex plugin marketplace upgrade qwen-mm-plugins\`, \`codex plugin add qwen-mm-plugins-<cap>@qwen-mm-plugins\`
- OpenClaw: \`openclaw plugins install qwen-mm-plugins-<cap> --marketplace https://github.com/QwenLM/Qwen-MM-Plugins.git\`
- Qwen Code: \`qwen extensions install https://github.com/QwenLM/Qwen-MM-Plugins.git:qwen-mm-plugins-<cap> --consent\`
The marketplace \`add\` command also accepts a local repo path; re-running is safe.

## Step 4 — Install system dependencies
\`uvx\` resolves Python deps on first launch — no manual pip. Install only **system tools** yourself:
- **Required:** \`ffmpeg\` (video / audio)
- **Optional:** \`libreoffice\` (document conversion), \`blender\`, \`texlive\`, \`chromium\` (for \`visualize\`)
Verify: \`bash install.sh verify\` (fetches each capability env and runs \`--check-system\`).

## Step 5 — Configure API keys (API-based tools only; native reading needs none)
| Variable | Used by |
|---|---|
| \`DASHSCOPE_API_KEY\` | \`vision_chat\`, \`ocr\`, \`grounding\`, \`transcribe_audio\`, generation, video-memory build |
| \`SERPER_API_KEY\` | \`web_search\`, \`web_extractor\`, \`image_search\` |
Persist: \`bash install.sh configure\` (writes \`~/.qwen-mm-plugins/config\`), or export manually. The config file is read whenever the env var is missing.

## Step 6 — Use it
Reference a file and ask — the model picks the right tool automatically (dynamic-resolution, no manual resizing):
\`\`\`text
@dashboard-4k.png       Read every number in this dashboard.
@report.pdf             Summarize page 3.
@receipt.jpg            OCR this and total the line items.
@street.jpg             Draw a box around every car in the scene.
@lecture-2h.mp4         What are the main points, with timestamps?
Generate a 1024x1024 image of a red panda coding at night.
Model a low-poly wooden stool, add a warm key light, and render it.
Model an M6 hex bolt 30 mm long and export it as STEP.
@geometry-problem.png   Explain how to solve this as a narrated video.
\`\`\`

## Rules / checks
- **Re-run-safe:** \`marketplace add\` and the installer are idempotent.
- **Codex gotcha:** run \`codex plugin marketplace upgrade qwen-mm-plugins\` before \`plugin add\` to pick up newly-published capabilities.
- **WSL only on Windows.** Native Windows is unsupported.
- **Harness not in the installer list?** Follow manual blocks in \`docs/en/installation.md\` or ask the agent: "install qwen-mm-plugins-<cap>".
- **Blender / FreeCAD** are thin clients — start the host app first; the MCP server talks to it via Python.
- **edu-agent** is skill-only (no MCP server) — install it without expecting tool calls.
- **No DASHSCOPE key?** Native image / video / document reading still works; only API-backed tools (OCR, grounding, generation, web search, ASR) fail.

## Verification checklist
- [ ] \`bash install.sh verify\` reports no missing system tools (or only optional ones you accept).
- [ ] The configured capability appears in the harness plugin/skill list.
- [ ] A simple prompt like \`@<local-image>.jpg describe this\` returns a description.
- [ ] For API tools: a prompt that requires OCR, grounding, web search, or generation succeeds (proves keys are loaded).
- [ ] For Blender/FreeCAD: the host app is running before invoking tools.
`,
};

registerCodingSkill(qwenMmPluginsInstallSetup);
