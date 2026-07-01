# AGENTS.MD — zelari-code

> Auto-curated by Zelari Code council. Run `/council` to refresh.
> See `.zelari/` for raw decision log.

## Overview

_Free-form project description. This section is manual and preserved across updates._

## Tech Stack

<!-- zelari:auto:start section="tech-stack" -->
<!-- Auto-derived from package.json -->

**Runtime:**
- ink `^6.8.0`
- ink-text-input `^6.0.0`
- react `^19.2.7`
- zod `^4.4.3`

**Dev:**
- @types/node `^25.3.0`
- @types/react `^19.0.10`
- esbuild `^0.24.0`
- typescript `~5.7.2`
- vitest `^2.1.9`

<!-- zelari:auto:end section="tech-stack" -->

## Decisions

<!-- zelari:auto:start section="decisions" -->
See `.zelari/decisions/` for full ADRs (context/decision/consequences).

**Accepted:**
_none yet_

**Proposed:**
- **001-new-decision** _(proposed)_
- **002-new-decision** _(proposed)_
- **003-new-decision** _(proposed)_
- **004-new-decision** _(proposed)_
- **005-new-decision** _(proposed)_
- **006-new-decision** _(proposed)_
- **007-new-decision** _(proposed)_
- **008-new-decision** _(proposed)_
- **009-new-decision** _(proposed)_
- **010-new-decision** _(proposed)_

<!-- zelari:auto:end section="decisions" -->

## Conventions

<!-- zelari:auto:start section="conventions" -->
<!-- Zelari Code defaults -->

- One tool definition per file in `src/main/core/tools/builtin/`
- Async-first; never block the event loop
- Zod schemas for all LLM tool args
- Single-task atomic commits; no batching
- Zero new heavy deps (lodash, immer, etc.) — use std lib
- Files ≤ 300 LOC preferred for new modules

<!-- zelari:auto:end section="conventions" -->

## Build

<!-- zelari:auto:start section="build" -->
<!-- Auto-derived from package.json scripts -->

`npm run build` — tsc -p tsconfig.json && node scripts/bundle-cli.mjs
`npm run build:cli` — tsc -p tsconfig.json && node scripts/bundle-cli.mjs
`npm run prepublishOnly` — node scripts/prepublish.mjs
`npm run smoke` — node bin/zelari-code.js --version
`npm run test` — vitest run
`npm run test:watch` — vitest
`npm run typecheck` — tsc --noEmit -p tsconfig.json

<!-- zelari:auto:end section="build" -->

## Open Questions

<!-- zelari:auto:start section="open-questions" -->
_No open questions._
<!-- zelari:auto:end section="open-questions" -->
