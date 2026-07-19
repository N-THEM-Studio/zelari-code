# Dogfood — experiment/plan-multiagent-build-agent

**Date:** 2026-07-19  
**Branch:** `experiment/plan-multiagent-build-agent`  
**Provider used (working):** `openai-compatible` / `ciuby-flash`  
**Broken default config:** active `grok` + model `default-grok` → HTTP 404 (model not found)

## Results

| Scenario | Policy | Time | Outcome | Notes |
|----------|--------|------|---------|--------|
| Agent only `hello.txt` | n/a | ~5s | **PASS** | `write_file` ok with ciuby-flash |
| Zelari impl + seeded plan | **build@agent** (default) | **~18s** | **success** | `index.html` with Hello Zelari; log shows `build@agent` |
| Zelari impl + seeded plan | **build@council** (`ZELARI_BUILD_VIA_AGENT=0`) | **~113s** | **stalled** | File was written mid-council; mission reported 0 writes → stall; much more token burn |
| Free-form council+build soft-gate | no `COUNCIL_CAN_BUILD` | ~2.5m | design-phase forced | Soft-gate log OK; **product `note.txt` still appeared** (leak — see open issues) |
| Greenfield zelari w/ broken model | default grok | ~3s | false **success** | Fixed: zero-write cannot complete |

## Fixes applied during dogfood

1. **`completion.ok` + 0 writes → success** — vacuous verification on empty tree.  
   - `missionSlice.ts`: hard-gate `completionOk=false` when `writeCount===0`  
   - `zelariMission.ts`: ignore `completionOk` if `writeCount===0`  
   - Commit: `fix(zelari): never succeed impl slice with zero project writes`

2. **Soft-gate without planMode tools** — design-phase still had mutators.  
   - Headless + TUI: soft-gate now also sets `planMode` tool registry.

## Comparison (seeded plan, same task)

| Metric | build@agent | build@council (legacy) |
|--------|-------------|-------------------------|
| Wall time | ~18s | ~113s (~6×) |
| Mission status | success | stalled (false no-write) |
| Deliverable on disk | yes | yes (but gate confused) |
| Roster | 1 agent | 6 members |
| Emit label | `build@agent` | `council completo` |

## Open issues

1. **Default provider model `default-grok` is invalid** — dogfood with default config fails all LLM calls; not introduced by this experiment but blocks default TUI/headless.
2. **Council soft-gate may still allow product writes** — observed `note.txt` after soft-gate; verify MCP tools / harness path; consider stripping MCP mutators when soft-gated.
3. **Legacy council writeCount** — multi-member runs may under-count writes → stall despite files on disk.
4. **Push/PR** — branch is local only; open when ready.

## Manual repro (working)

```powershell
$env:ZELARI_MISSION_AUTO=1
$env:ZELARI_MISSION_MAX_ITER=2
$env:ZELARI_CHECKPOINT=0
# optional: Remove-Item Env:ZELARI_BUILD_VIA_AGENT  # default build@agent
# legacy:  $env:ZELARI_BUILD_VIA_AGENT='0'

# seed plan so mission skips design-phase
mkdir .zelari -Force
# write minimal plan.json with ≥1 phase

node path\to\zelari-code\bin\zelari-code.js `
  --headless --mode zelari --phase build `
  --provider openai-compatible --model ciuby-flash `
  --task "implementa index.html con h1 Hello Zelari" `
  --output plain
```
