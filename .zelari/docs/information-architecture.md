---
kind: doc
id: information-architecture
date: 2026-07-16
tags: [design-phase, gerione, ideation]
---
# Information Architecture — zelari-code

## Monorepo Sitemap

```
zelari-code/
├── packages/
│   └── core/                    # @zelari/core runtime
│       ├── src/
│       │   ├── council/         # orchestratore 6 agenti
│       │   ├── llm/             # adapter Anthropic / OpenAI / local
│       │   ├── prompts/         # system prompt per ruolo
│       │   └── tools/           # filesystem, search, edit
│       └── tests/
├── apps/
│   └── desktop/                 # GUI Tauri (optional, secondaria)
├── src/
│   ├── cli/                     # CLI binario (entrypoint TUI)
│   │   ├── commands/
│   │   │   ├── council.ts       # council run / resume
│   │   │   ├── mission.ts       # create / list / show
│   │   │   ├── plan.ts          # show / export
│   │   │   ├── ideate.ts        # Gerione shortcut
│   │   │   └── evaluate.ts      # Minosse shortcut
│   │   └── ui/                  # Ink components
│   └── mcp/                     # 5 MCP server
│       ├── filesystem/
│       ├── git/
│       ├── search/
│       ├── docs/
│       └── council-bridge/
├── .zelari/
│   ├── plan.json                # piano canonico (no duplicati)
│   ├── decisions/               # ADR per council run
│   └── mission-state.json
└── docs/
    ├── design/
    ├── adr/
    └── runbooks/
```

## Top-Level CLI Nav

| Comando           | Scopo                                  | Output          |
|-------------------|----------------------------------------|-----------------|
| `zelari`          | help + version                         | TUI splash      |
| `zelari council`  | avvia/resume council run               | TUI live        |
| `zelari mission`  | CRUD missioni                          | TUI list/detail |
| `zelari plan`     | visualizza/esporta piano corrente      | JSON / MD       |
| `zelari ideate`   | shortcut per ideation rapida           | Markdown doc    |
| `zelari evaluate` | shortcut per risk review               | Markdown doc    |
| `zelari mcp`      | start/stop MCP server                  | logs            |

## URL / Path Patterns

- **Mission ID**: `m_<8char-hash>` (es. `m_fd0f70ad`)
- **Plan version**: `v<major>.<minor>.<patch>` (es. `v0.10.0`)
- **ADR slug**: `NNNN-kebab-title.md` (es. `0007-council-api-refactor.md`)
- **Run output**: `.zelari/runs/<YYYY-MM-DD>/<mission-id>/`
- **Skill ref**: `skills/<skill-name>/SKILL.md`

## Nav Principi

1. **CLI-first, GUI opt-in** — TUI copre il 90% dei casi
2. **Stato in `.zelari/`** — unica fonte di verità, gitignored di default
3. **Artefatti linkabili** — ogni output ha path relativo copiabile
4. **Piano canonico singolo** — mai duplicati, post-processor valida
5. **Ruoli come scope** — ogni agent vede solo i file che gli servono
