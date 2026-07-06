# Zelari Code — Tool & Skill Map (v1.3.0)

Mappa completa di tool, skill e sorgenti di estensione. Aggiornata dopo
l'aggiunta dei tool v1.3.0 (LSP, AST, semantic search, browser verification)
e dei tool v1.2.0 (diagnostics loop, prompt-cache accounting, sub-agent delegation).

## Tool builtin (harness) — disponibili ovunque

| Tool | Permessi | Note |
|------|----------|------|
| `read_file` / `write_file` / `edit_file` | read/write | sandbox sul project root |
| `bash` | execute | shell blocklist; Git Bash su Windows, non-interattiva |
| `grep_content` | read | regex ricorsiva con include/exclude glob |
| `list_files` | read | listing ricorsivo con depth |
| `show_diff` / `apply_diff` | read/write | diff preview + patch |
| `fetch_url` | network | http(s) only, HTML→testo, 15s timeout, 40k char cap |
| `web_search` | network | DuckDuckGo HTML senza chiave; `TAVILY_API_KEY` per Tavily |

## Tool v1.3.0 — frontiera

| Tool | Permessi | Prereq | Note |
|------|----------|--------|------|
| `lsp_definition` | read | server LSP sul PATH (`typescript-language-server`, `pyright-langserver`, …) | go-to-definition via LSP |
| `lsp_references` | read | server LSP | find-references via LSP |
| `lsp_hover` | read | server LSP | hover type/info via LSP |
| `lsp_symbols` | read | server LSP | document symbols via LSP |
| `lsp_rename` | write | server LSP | rename symbol across workspace via LSP |
| `ast_outline` | read | nessuno | outline simboli TS via TypeScript Compiler API |
| `ast_find_symbol` | read | nessuno | find-by-name con scope TS via TS Compiler API |
| `semantic_search` | read | `ZELARI_SEMANTIC` ≠ `0`, modello embedding scaricato on first use | concept-level code search su embeddings locali (default `Xenova/all-MiniLM-L6-v2`) |
| `browser_check` | sandboxed network | `ZELARI_BROWSER` ≠ `0`, Playwright + chromium installati (`npx playwright install chromium`) | headless browser: goto / click / fill / wait + cattura console + network + screenshot |

Disabilitazione globale: `ZELARI_LSP=0`, `ZELARI_AST=0`, `ZELARI_SEMANTIC=0`, `ZELARI_BROWSER=0`.

## Tool v1.2.0 — agentic harness

| Tool / hook | Permessi | Note |
|-------------|----------|------|
| `diagnostics_loop` | read | dopo ogni `edit_file`/`write_file`, l'harness lancia `eslint`/`ruff` (LSP-pluggable) e inietta gli errori nel prompt del modello nello stesso turno. Timeout `ZELARI_DIAGNOSTICS_TIMEOUT_MS` (default 5000ms). |
| `task` | read (delegated, no recursion) | delega un sub-task a un sub-agente isolato con context proprio, registry read-only, max 12 turni, no `task` ricorsivo |
| prompt-cache accounting | — | metrica per provider/modello del prompt-cache hit rate, esposta in status bar (`cache 73%`) |

## Tool workspace (stub `.zelari/`) — council sempre, agente singolo on demand

`createPhase`, `createTask`, `updateTask`, `addIdea`, `createMilestone`,
`createDocument`, `searchDocuments`, `linkDocuments`, `getDocumentBacklinks`.

- **Council**: tutti registrati sempre.
- **Agente singolo**: `updateTask` quando esiste `.zelari/plan.json`; gli altri
  quando una `/skill` li dichiara in `requiredTools` (`searchRAG` è mappato a
  `searchDocuments`).

## Tool MCP

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
- **SKILL.md utente**: formato condiviso con opencode / Hermes /
  Claude Code. Directory di discovery (la prima occorrenza di un nome vince):
  1. `<project>/.zelari/skills/<name>/SKILL.md`
  2. `<project>/.claude/skills/<name>/SKILL.md`
  3. `<project>/.opencode/skills/<name>/SKILL.md`
  4. `<project>/.hermes/skills/<name>/SKILL.md`
  5. `~/.zelari-code/skills/<name>/SKILL.md`

  Frontmatter: `name` (kebab-case, obbligatorio), `description` (obbligatorio),
  opzionali `category` (plan|refactor|debug|review|test|docs|ops|git|db|maint),
  `tools` (→ requiredTools), `cost` (low|medium|high). Il corpo markdown è il
  systemPromptFragment. Qualunque skill dell'ecosistema opencode/Hermes/Claude
  può essere copiata così com'è e invocata con `/skill <name>`.

## Slash commands correlati

- `/index` — costruisce / rinfresca l'indice vettoriale per `semantic_search`.
- `/checkpoint [label]` — snapshot del working tree (target di rollback).
- `/rollback [id|latest]` — ripristino atomico di un checkpoint.

## Gap noti (decisi, non dimenticati)

- **computer_use** (Hermes): fuori scope CLI — la CLI gira in TUI/headless, non su desktop.
- **searchRAG semantico su `.zelari/docs/`**: in v1.3.0 `semantic_search` copre il codice via embeddings locali; il retrieval semantico sui documenti del council resta un MCP pluggable (gap colmabile senza modificare il core).