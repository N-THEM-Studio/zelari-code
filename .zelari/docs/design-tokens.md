---
kind: doc
id: design-tokens
date: 2026-07-16
tags: [design-phase, gerione, ideation]
---
# Design Tokens — zelari-code TUI

## Color Palette (TUI 16-color safe)

### Brand
| Token              | Hex      | ANSI      | Uso                        |
|--------------------|----------|-----------|----------------------------|
| `--brand-primary`  | `#7C3AED`| magenta   | logo, header, focus border |
| `--brand-accent`   | `#22D3EE`| cyan      | link, citation, ADR tag    |
| `--brand-warm`     | `#F59E0B`| yellow    | warning, in-progress gate  |

### Semantic
| Token              | Hex      | ANSI      | Uso                        |
|--------------------|----------|-----------|----------------------------|
| `--state-success`  | `#10B981`| green     | passed gate, commit ok     |
| `--state-warning`  | `#F59E0B`| yellow    | pending, stale auth        |
| `--state-danger`   | `#EF4444`| red       | failed gate, blocked task  |
| `--state-muted`    | `#6B7280`| gray      | placeholder, dim text      |

### Agent Colors (per council)
| Agent     | Colore    | ANSI    |
|-----------|-----------|---------|
| Caronte   | `#7C3AED` | magenta |
| Nettuno   | `#3B82F6` | blue    |
| Gerione   | `#EC4899` | pink    |
| Plutone   | `#8B5CF6` | violet  |
| Minosse   | `#EF4444` | red     |
| Lucifero  | `#FBBF24` | yellow  |

---

## Typography

Solo **monospace** (obbligo TUI). Stack con fallback sicuri:

```
JetBrains Mono, Fira Code, SF Mono, Menlo, Consolas, monospace
```

| Token        | Size   | Weight | Uso                          |
|--------------|--------|--------|------------------------------|
| `--text-xs`  | 10 px  | 400    | metadata, timestamp          |
| `--text-sm`  | 12 px  | 400    | body, log lines              |
| `--text-md`  | 14 px  | 500    | section header, agent name   |
| `--text-lg`  | 16 px  | 600    | top-level title              |
| `--text-xl`  | 20 px  | 700    | splash, mission banner       |

---

## Spacing Scale (cell-based)

| Token       | Cells | Uso                          |
|-------------|-------|------------------------------|
| `--s-0`     | 0     | inline                       |
| `--s-1`     | 1     | tight separator              |
| `--s-2`     | 2     | default gap                  |
| `--s-3`     | 3     | section break                |
| `--s-4`     | 4     | block padding                |
| `--s-6`     | 6     | panel margin                 |

---

## Motion

| Token         | Duration | Easing              | Uso                          |
|---------------|----------|---------------------|------------------------------|
| `--fade-in`   | 120 ms   | ease-out            | panel mount                  |
| `--tick`      | 200 ms   | linear              | spinner, live status         |
| `--slide`     | 180 ms   | cubic-out           | drawer open/close            |
| `--pulse`     | 1.2 s    | ease-in-out loop    | "council thinking" indicator |

**Regola TUI**: niente animazioni > 250 ms. Refresh rate rispettato da Ink
in 60 fps dove supportato, fallback a 30 fps su terminali lenti.

---

## Border & Surface

| Token              | Stile              | Uso                  |
|--------------------|--------------------|----------------------|
| `--border-subtle`  | dim gray           | box secondario       |
| `--border-focus`   | brand-primary 1px  | pannello attivo      |
| `--surface-raised` | bg +5% lightness   | card, modal          |
| `--surface-sunken` | bg -5% lightness   | code block, log area |
