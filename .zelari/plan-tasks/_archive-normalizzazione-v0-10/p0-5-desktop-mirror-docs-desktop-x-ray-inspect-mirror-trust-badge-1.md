---
kind: task
id: p0-5-desktop-mirror-docs-desktop-x-ray-inspect-mirror-trust-badge-1
phaseId: p0-5-desktop-mirror-docs
status: pending
priority: medium
tags: [apps/desktop, src/cli/desktopConfig.ts, .zelari/docs/design-tokens.md, .zelari/docs/information-architecture.md]
---
# Desktop X-Ray: inspect mirror + trust badge

Surface Desktop che chiama inspect --json via headless/CLI spawn; badge trust (token color.trust.*) in chrome UI. Read-only v1.

## File references
- `apps/desktop`
- `src/cli/desktopConfig.ts`
- `.zelari/docs/design-tokens.md`
- `.zelari/docs/information-architecture.md`

## Acceptance criteria
- UI mostra trusted/untrusted per workspace aperto
- Pannello X-Ray elenca hooks e MCP da JSON inspect
- Nessuna nuova IPC privilegiata oltre spawn CLI

## QA scenario

Aprire Desktop su repo untrusted → badge rosso; trust da CLI → refresh badge verde.
