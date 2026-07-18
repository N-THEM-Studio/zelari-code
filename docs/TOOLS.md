# Zelari Code — Tool & Skill Map (≥ 1.14)

Mappa di tool, skill e sorgenti di estensione. Allineata al registry CLI
(`src/cli/toolRegistry.ts`) e agli stub workspace.

Prodotto: [Anathema Studio](https://anathema-studio.com/) · CLI MIT.

## Tool builtin (harness) — disponibili ovunque

| Tool | Permessi | Note |
|------|----------|------|
| `read_file` / `write_file` / `edit_file` | read/write | sandbox sul project root |
| `bash` | execute | shell blocklist; Git Bash su Windows |
| `grep_content` | read | regex ricorsiva con include/exclude glob |
| `list_files` | read | listing ricorsivo con depth |
| `show_diff` / `apply_diff` | read/write | diff preview + patch |
| `fetch_url` | network | http(s) only, HTML→testo, timeout + char cap |
| `web_search` | network | DuckDuckGo HTML; `TAVILY_API_KEY` per Tavily |
| `task` | read (sub-agent) | sub-agente isolato, registry read-only, no ricorsione |
| `update_world_hypothesis` | write | `.zelari/world/hypothesis.md` (Schema-style notes) |
| `set_world_checks` | write | `.zelari/world/checks.json` |
| `run_backtest` | execute | certifica i check; non claim-done se red |
| `record_world_observation` | write | timeline append-only |

World-model tools: kill switch `ZELARI_SCHEMA_LOOP=0`. Skill: `schema-loop`.

## Capability avanzate (opt-in)

| Tool | Permessi | Prereq | Note |
|------|----------|--------|------|
| `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_symbols` / `lsp_rename` | read / write (`rename`) | language server sul PATH | kill switch `ZELARI_LSP=0` |
| `ast_outline` / `ast_find_symbol` | read | nessuno (TS Compiler API) | `ZELARI_AST=0` |
| `semantic_search` | read | embeddings on first use; `/index` | `ZELARI_SEMANTIC=0` |
| `browser_check` | sandboxed network | Playwright + chromium | `ZELARI_BROWSER=0` |

**Diagnostics loop** (non un tool separato): dopo `write_file` / `edit_file` / `apply_diff` l’harness può lanciare `eslint`/`ruff` e appendere errori al result. `ZELARI_DIAGNOSTICS=0`.

## SSH (deploy / monitor)

| Tool | Note |
|------|------|
| `ssh_status` | Health check su target configurato |
| `ssh_run` | Comando remoto **allowlist-only** |

Config: `~/.zelari-code/ssh-targets.json` (+ secrets separati). Kill switch: `ZELARI_SSH=0`.  
Desktop: Settings → Connections.

## Workspace tools (`.zelari/`)

Usati soprattutto dal **council** (sempre registrati lì). Agente singolo: su skill `requiredTools` o quando esiste un plan.

| Tool | Note |
|------|------|
| **`createPlan`** | Batch preferito: fasi + task + milestone in **una** call |
| `createPhase` / `createTask` / `updateTask` / `createMilestone` | Itemizzati (legacy / partial) |
| `createNfrSpec` | Spec NFR (motion/perf/a11y) quando serve |
| `createDocument` / `searchDocuments` / `linkDocuments` / `getDocumentBacklinks` | Knowledge vault progetto |
| `addIdea` | Ideazione |

Alias: `searchRAG` → `searchDocuments` (via registry “Did you mean”).

## Plan phase vs build phase

Ortogonale a mode `agent` | `council` | `zelari` (`/plan`, `/build`, `--phase`).

| Phase | Comportamento registry |
|-------|------------------------|
| **plan** | Bloccati: `write_file`, `edit_file`, `apply_diff`, `bash` (+ spesso `task`). Workspace plan/docs tools **consentiti** |
| **build** | Tool completi (sandbox + blocklist restano) |

## Parallel tool batch (harness)

Su un finish multi-`tool_call`, `AgentHarness` segmenta in emission order:

- run **contigue** di tool read-only → `Promise.all` (chunk `ZELARI_MAX_PARALLEL_TOOLS`, default 6)
- tool con permission **write** o **execute** → **barrier** seriale
- ordine risultati = ordine emission (no reorder)

Opt-out: `ZELARI_PARALLEL_TOOLS=0`.

## Tool MCP

Config (formato Claude-Desktop-compatibile; il progetto vince sui conflitti):

- `<project>/.zelari/mcp.json`
- `~/.zelari-code/mcp.json`

I tool scoperti sono `mcp_<server>_<tool>`. Kill switch: `ZELARI_MCP=0`.  
Hermetic / CI: `ZELARI_MCP_USER=0` ignora `~/.zelari-code/mcp.json` (solo project config).

### Cua Driver (desktop computer-use)

[Cua Driver](https://cua.ai/cua-driver) (trycua) pilota **app native** in background via MCP (click, type, snapshot finestra senza rubare focus). **Non** è vendored: installi il binary a parte.

```bash
# 1) Install binary — https://cua.ai/docs/how-to-guides/driver/install
# 2) Register MCP preset (user scope):
zelari-code --set-mcp-preset cua

# Equivalente manuale:
# zelari-code --set-mcp --name cua-driver --command cua-driver --args '["mcp"]'
```

| Env | Effetto |
|-----|---------|
| `ZELARI_CUA=0` | Non avvia server MCP Cua (`cua-driver`, `cua-*`) |
| `ZELARI_CUA_COUNCIL=1` | Espone tool Cua anche ai turn council (default: **solo agent**, per non saturare i 6 membri) |
| `ZELARI_MCP=0` | Disabilita tutto MCP (incluso Cua) |

Preferisci `browser_check` (Playwright) per **web**; Cua per **desktop nativo**.  
Skill: `computer-use-cua` (`/skill computer-use-cua`). Doctor: `zelari-code --doctor` segnala se `cua-driver` manca dal PATH.

## Coerenza prompt ↔ esecuzione

1. **`harnessToolBridge`**: builtin harness nel catalogo `getAllTools()` con schemi dagli zod reali.
2. **Filtro executable**: AVAILABLE TOOLS e schemi provider filtrati sul registry corrente.
3. **Alias**: `Read`→`read_file`, `Glob`/`list_dir`→`list_files`, `searchRAG`→`searchDocuments`, `shell`→`bash`, …

## Skills

- Catalogo knowledge + coding skills in `@zelari/core` (`systemPromptFragment` + `requiredTools`)
- User skills: `SKILL.md` sotto `.zelari/skills/`, `.claude/skills/`, …
- Invocazione: `/skill <id>`; master switch via config `enabledSkills` / `enabledTools`

Vedi anche [GUIDA.md](./GUIDA.md) e [README](../README.md).
