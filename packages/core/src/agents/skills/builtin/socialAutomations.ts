/**
 * Builtin skill: social-automations — the "posting bot" procedure.
 *
 * Manages Zelari Code social-posting automations end-to-end from natural
 * language (create / schedule / run / disable / remove) through the
 * `zelari-code automation` CLI. Registered into the shared catalog at import
 * time; surfaced as `/skill social-automations` (CLI picker + Desktop Skills
 * button). The fragment is pure instructions — no execution happens here.
 */
import type { CodingSkillDefinition } from '../../skills.js';
import { registerCodingSkill } from '../../skills.js';

const socialAutomations: CodingSkillDefinition = {
  id: 'social-automations',
  version: '1.0.0',
  name: 'Social Automations',
  description:
    'Create, schedule, run, disable and remove social posting automations ' +
    '(Facebook/X/website) from natural language — a local posting bot with ' +
    'research, drafts and human approval.',
  category: 'ops',
  requiredRoles: ['nettun', 'pluton'],
  requiredTools: ['web_search', 'read_file', 'write_file'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'The user asks to schedule or program recurring social posts',
    'The user wants to publish to Facebook/X/their website on a cadence',
    'The user asks to pause, resume, inspect or remove a posting automation',
    'The user mentions a "posting bot" or Grok-bot-style scheduled posting',
  ],
  antiPatterns: [
    'A one-off single post with no schedule — just draft it in chat instead',
    'The user asks for API/Graph integrations — this skill drives the browser-first channels',
  ],
  requires: [],
  relatedSkills: [],
  tags: ['automations', 'social', 'posting', 'scheduling', 'facebook', 'x'],
  examples: [
    {
      input:
        'programma 2 post al giorno sul mio profilo facebook relative alle ultime notizie in campo AI, fai prima le ricerche poi prepara il post, aggiungi alla fine di ciascuno un CTA che riporti al mio sito <<https://esempio.it>>',
      output: {
        spec: 'ai-news-facebook — cron "0 9,18 * * *", channels [facebook], researchQuery set',
        registered: true,
        report: 'drafts await approval in Settings → Automations',
      },
    },
    {
      input: 'disattiva la automazione ai-news-facebook e dimmi come è andata finora',
      output: {
        spec: 'ai-news-facebook',
        registered: true,
        report: 'set-enabled false + honest runs summary (exit 4 = unproven)',
      },
    },
  ],
  outputSchema: '{ spec: string; registered: boolean; report: string }',
  systemPromptFragment: `# Social Automations — posting bot

You manage Zelari Code social-posting automations end-to-end from natural language: create, schedule, run, disable, re-enable, inspect, modify and remove. Registry: Settings → Automations (Desktop) and \`.zelari/automations/\` (specs + run evidence).

CLI surface (from the project root; if \`zelari-code\` is not on PATH use \`node bin/zelari-code.js\`):
- \`automation upsert --file <spec.json> [--json]\` — create/update a spec (zod validates; errors list the exact field)
- \`automation register --id <id>\` — materialize the OS schedule (schtasks/launchd/crontab; survives Desktop closed); \`automation remove --id <id>\` — remove the OS schedule only
- \`automation delete --id <id>\` — delete the spec (full teardown = remove + delete)
- \`automation set-enabled --id <id> --value true|false\` — pause/resume
- \`automation run --id <id>\` — manual run (once by design: draft → approval → publish)
- \`automation list --json\`, \`automation runs --id <id> --json\`, \`automation pending --json\`, \`automation status --id <id>\`
- \`automation login <channel>\` (opens a VISIBLE browser for the user's MANUAL login — never touch credentials), \`automation health <channel>\`, \`automation probe <channel> --publish\`
- \`automation credential website --endpoint URL [--secret]\`

## Step 1 — Parse the request
Extract: channels (facebook | x | website), frequency, topic/brief, CTA, links wrapped in \`<<...>>\`, tone, model (ONLY if the user names one), approval (default ON).
Frequency mapping (timezone default Europe/Rome, exactly ONE trigger per spec):
- "2 post al giorno" → \`schedule.cron: "0 9,18 * * *"\`; 3/day → \`"0 8,13,19 * * *"\`
- "3 post settimanali" → \`"0 10 * * 1,3,5"\` (spread across weekdays)
- "ogni N ore" → \`intervalMin: N*60\`; "all'avvio del PC" → \`atLogon: true\`

## Step 2 — Research first (when asked: "fai prima le ricerche", "ultime notizie", "prendi le info da <<url>>")
- Use web_search for news/queries; fetch_url to read pages the user linked.
- Distill 5–10 factual bullets WITH their source URLs into \`topicOrBrief\`. Never invent facts or numbers.
- For recurring freshness ALSO set \`social_post.researchQuery\` (e.g. "latest AI news this week"): the runner re-searches at EVERY draft and feeds fresh results to the model.

## Step 3 — Compose the spec
\`\`\`json
{
  "id": "ai-news-facebook",
  "name": "AI news — Facebook",
  "enabled": true,
  "kind": "social_post",
  "schedule": { "cron": "0 9,18 * * *", "timezone": "Europe/Rome" },
  "budget": { "maxCostUsd": 1 },
  "social_post": {
    "channels": ["facebook"],
    "topicOrBrief": "<researched bullets with sources>",
    "researchQuery": "latest AI news this week",
    "prompt": "Write a concise engaging post about the latest AI news from the brief. Italian. End with this exact CTA followed by the link: <<CTA text>> <<https://...>>",
    "requireApproval": true,
    "publishMode": "dry-run"
  }
}
\`\`\`
Rules:
- \`id\`: short kebab-case from the purpose.
- \`model\`: set \`{ "id": "..." }\` (provider optional = active) ONLY if the user explicitly named a model.
- \`publishMode: "browser"\` ONLY if the channel session is verified (\`automation health <channel>\`); otherwise keep \`"dry-run"\` and tell the user to run \`automation login <channel>\` first (you may run it: visible browser, THE USER logs in manually).
- \`requireApproval: true\` unless the user EXPLICITLY demands unattended posting — then state the risk once.
- website channel needs \`automation credential website\` configured first.

## Step 4 — Apply & verify
1. Write the spec to a temp file and \`automation upsert --file ... --json\`; fix any zod error reported.
2. \`automation register --id <id>\` (OS schedule).
3. Optional smoke: \`automation run --id <id>\` then \`automation runs --id <id> --json\`.
4. REPORT: schedule in human words, channels, model (or "active model"), approval flow (draft → Allow in Desktop → permalink as evidence), researchQuery if set.

## Lifecycle requests
- "disattiva/ferma" → \`set-enabled --value false\`; "riattiva" → true.
- "rimuovi/elimina" → \`automation remove --id <id>\` (OS) + \`automation delete --id <id>\` (spec).
- "come va / cronologia" → \`runs --json\`, summarize HONESTLY: exit 4 = unproven, \`relogin_required\` = user must login again; never claim a post is published without its permalink URL.
- "cambia orario/topic/prompt" → edit spec fields and \`upsert\` again with the same id.

## Hard guardrails
- NEVER set requireApproval=false silently; NEVER fabricate or guess permalinks/URLs; NEVER type credentials or automate logins; NEVER post in browser mode without a verified session.
- If web research fails at creation time, say so and proceed only with the user's brief.`,
};

registerCodingSkill(socialAutomations);
