---
kind: task
id: p0-5-desktop-mirror-quality-gate-desktop-trustbadge-x-ray-mirror-inspect-1
phaseId: p0-5-desktop-mirror-quality-gate
status: pending
priority: medium
tags: [apps/desktop, .zelari/docs/design-tokens.md, .zelari/docs/knowledge-map.md]
---
# Desktop TrustBadge + X-Ray mirror inspect

Badge trust in header workspace (token color.trust.*). Drawer X-Ray legge stesso JSON inspect / store trusted_folders.toml — nessun trust store parallelo in Tauri.

## File references
- `apps/desktop`
- `.zelari/docs/design-tokens.md`
- `.zelari/docs/knowledge-map.md`

## Acceptance criteria
- Badge riflette isTrusted del cwd aperto
- X-Ray sezioni = inspect CLI
- Nessun secondo file trust lato Tauri

## QA scenario

Apri Desktop su repo untrusted; badge warn; trust da CLI; refresh; badge ok; X-Ray = inspect --json.
