---
kind: task
id: p0-5-desktop-mirror-trustbadge-x-ray-trustbadge-xraypanel-in-apps-desktop-con-ipc-bridge-1
phaseId: p0-5-desktop-mirror-trustbadge-x-ray
status: pending
priority: high
tags: [apps/desktop/src/components/TrustBadge.tsx (nuovo), apps/desktop/src/components/XRayPanel.tsx (nuovo), apps/desktop/src/agentClient.ts (IPC bridge), apps/desktop/src/App.tsx (wiring sidebar), apps/desktop/src/components/desktop-config.test.ts (update)]
---
# TrustBadge + XRayPanel in apps/desktop con IPC bridge

Creare apps/desktop/src/components/TrustBadge.tsx che legge /.zelari/trust.json via nuovo IPC bridge in apps/desktop/src/agentClient.ts (invokeTrustStatus). Creare XRayPanel.tsx che consuma /inspect JSON via stesso reader della CLI. Wiring in App.tsx: toggle nella sidebar. Aggiornare apps/desktop/src/components/desktop-config.test.ts esistente con mock IPC.

## File references
- `apps/desktop/src/components/TrustBadge.tsx (nuovo)`
- `apps/desktop/src/components/XRayPanel.tsx (nuovo)`
- `apps/desktop/src/agentClient.ts (IPC bridge)`
- `apps/desktop/src/App.tsx (wiring sidebar)`
- `apps/desktop/src/components/desktop-config.test.ts (update)`

## Acceptance criteria
- TrustBadge mostra stato trusted/untrusted/scope reale da trust.json
- XRayPanel renderizza sezioni trust/hooks/mcp/skills/plugins collassabili
- Toggle sidebar apre/chiude pannello X-Ray
- desktop-config.test.ts verde con mock IPC

## QA scenario

1. Avvio desktop su cwd trusted → TrustBadge verde. 2. Click sidebar X-Ray → pannello mostra sezioni con dati reali. 3. cwd untrusted → badge rosso.
