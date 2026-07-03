# Zelari Code — Tool & Skill Map (v0.7.5)

Mappa completa di tool, skill e sorgenti di estensione. Aggiornata dopo il
confronto con [opencode](https://opencode.ai/docs/tools/) e
[Hermes Agent](https://github.com/NousResearch/hermes-agent) (2026-07-03).

## Tool builtin (harness) — disponibili ovunque

| Tool | Permessi | Note |
|------|----------|------|
| `read_file` / `write_file` / `edit_file` | read/write | sandbox sul project root |
| `bash` | execute | shell blocklist; Git Bash su Windows, non-interattiva |
| `grep_content` | read | regex ricorsiva con include/exclude glob |
| `list_files` | read | listing ricorsivo con depth |
| `show_diff` / `apply_diff` | read/write | diff preview + patch |
| `fetch_url` | network | **v0.7.5** — http(s) only, HTML→testo, 15s timeout, 40k char cap |
| `web_search` | network | **v0.7.5** — DuckDuckGo HTML senza chiave; `TAVILY_API_KEY` per Tavily |

## Tool workspace (stub `.zelari/`) — council sempre, agente singolo on demand

`createPhase`, `createTask`, `updateTask`, `addIdea`, `createMilestone`,
`createDocument`, `searchDocuments`, `linkDocuments`, `getDocumentBacklinks`.

- **Council**: tutti registrati sempre.
- **Agente singolo**: `updateTask` quando esiste `.zelari/plan.json`; gli altri
  quando una `/skill` li dichiara in `requiredTools` (`searchRAG` è mappato a
  `searchDocuments`).

## Tool MCP — v0.7.5

Config (formato Claude-Desktop-compatibile, il progetto vince sui conflitti):

- `<project>/.zelari/mcp.json`
- `~/.zelari-code/mcp.json`

```json
{ "mcpServers": { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } } }
```

I tool scoperti sono registrati come `mcp_<server>_<tool>` in entrambi i path
(agente singolo + council). Server avviati lazy una volta per processo; un
server rotto viene disattivato con un warning in chat, mai retry-storm.
Kill switch: `ZELARI_MCP=0`.

## Coerenza prompt ↔ esecuzione (le 3 regole anti-allucinazione)

1. **`harnessToolBridge`** (core): i builtin harness sono nel catalogo
   `getAllTools()` con gli schemi JSON derivati dagli zod reali — il blocco
   AVAILABLE TOOLS dei membri del council mostra gli stessi tool che il
   registry esegue.
2. **Filtro executable**: sia gli schemi provider sia il testo AVAILABLE TOOLS
   dei membri sono filtrati sui nomi presenti nel registry corrente.
3. **Alias "Did you mean"**: `Read`→`read_file`, `Glob`/`list_dir`/`ls`→
   `list_files`, `searchRAG`→`searchDocuments`, `shell`→`bash`, ecc. — un nome
   allucinato produce un errore con il nome giusto da riprovare.

## Skill

- **Builtin (23 coding skill)**: `packages/core/src/agents/skills/builtin/*` —
  usate dal council (per ruolo) e via `/skill <id>`.
- **SKILL.md utente — v0.7.5**: formato condiviso con opencode / Hermes /
  Claude Code. Directory di discovery (la prima occorrenza di un nome vince):
  1. `<project>/.zelari/skills/<name>/SKILL.md`
  2. `<project>/.claude/skills/<name>/SKILL.md`
  3. `<project>/.opencode/skills/<name>/SKILL.md`
  4. `~/.zelari-code/skills/<name>/SKILL.md`

  Frontmatter: `name` (kebab-case, obbligatorio), `description` (obbligatorio),
  opzionali `category` (plan|refactor|debug|review|test|docs|ops|git|db|maint),
  `tools` (→ requiredTools), `cost` (low|medium|high). Il corpo markdown è il
  systemPromptFragment. Qualunque skill dell'ecosistema opencode/Hermes/Claude
  può essere copiata così com'è e invocata con `/skill <name>`.

## Gap noti (decisi, non dimenticati)

- **LSP** (opencode/Hermes ce l'hanno): fuori scope per ora — costo alto.
- **searchRAG semantico**: nella CLI `searchDocuments` è keyword-match su
  `.zelari/**`; il RAG vero resta nell'app Electron. Un MCP server di
  retrieval può colmare il gap senza codice.
- **browser_navigate / computer_use** (Hermes): fuori scope CLI.
