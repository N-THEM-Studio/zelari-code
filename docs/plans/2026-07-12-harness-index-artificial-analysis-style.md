# Valutare Zelari harness vs altri (stile Artificial Analysis Index), a parità di modello

> **Status:** deferred — da eseguire in un secondo momento.  
> **Saved:** 2026-07-12  
> **Source:** session plan (AA-style harness eval)

## Domanda

Come fare un indice tipo **Artificial Analysis Coding Agent Index** per confrontare **Zelari (scaffold)** con altri agent stack, **tenendo fissi i modelli**?

## Risposta breve

Sì, è fattibile — ed è l’esperimento **giusto** per un product come Zelari.  
L’indice pubblico AA misura soprattutto **modelli** (spesso a scaffold fisso tipo mini-swe-agent).  
Il tuo obiettivo è l’inverso: **scaffold variabile, modello fisso** → score di *harness quality*.

---

## Cosa è l’AA Coding Agent Index (riferimento)

Composito tipico (snapshot 2026):

| Componente | Cosa misura |
|------------|-------------|
| **DeepSWE** (~113 task) | Long-horizon SWE su repo reali, verifier funzionali |
| **Terminal-Bench v2** | Task shell/macchina (Harbor) |
| **SWE-Atlas-QnA** (o simile) | Comprensione repo / Q&A |

Headline = media (o media pesata) **pass@1** (e a volte cost/time come secondari).

**Limite per te:** sul leaderboard ufficiale, l’harness è spesso **fisso** per isolare il modello.  
Quindi **non puoi “entrare” in classifica AA** solo installando Zelari: puoi **replicare la metodologia** in privato/report e dichiarare “Zelari scaffold vs mini-swe / Claude Code / …, model M”.

---

## Principio sperimentale (obbligatorio)

| Fisso | Variabile |
|-------|-----------|
| Task set + verifier + budget (timeout, max turn, $) | **Harness** (Zelari agent / council / mini-swe / OpenHands / …) |
| **Stesso model id** + temperature/default API | — |
| Stesso OS/container image (idealmente) | — |

Se cambi modello e harness insieme, il confronto è confuso.

---

## Design di un “Zelari Harness Index” (proposta)

### A. Suite (minimo serio, non serve full AA day-one)

| Track | N iniziale | Grader | Fit Zelari |
|-------|------------|--------|------------|
| **DeepSWE-subset** | 10–20 task (es. TS/JS) | Verifier DeepSWE / Pier | Coding multi-file |
| **Terminal-Bench sample** | 10–15 | Harbor / TB harness | Shell forte |
| **Internal Honesty pack** | 5–10 | Test + false-success rules | Differenziatore Zelari |

Poi, se budget ok: DeepSWE full + TB v2 full → composito “AA-like”.

### B. Bracci (harness)

1. **Zelari agent** (`--mode agent --phase build`)  
2. **Zelari council** (sample only: 3–5 task, costo alto)  
3. **Baseline esterno** (almeno uno): mini-swe-agent **stesso model**, o Claude Code / Aider se allineabile sullo stesso provider  

### C. Metriche (oltre pass@1)

| Metrica | Perché |
|---------|--------|
| **pass@1** | Allineamento AA |
| **cost / task, wall time** | Efficienza scaffold |
| **tool steps** | Thrash |
| **false success** | Claim done + verifier fail / DEGRADED |
| **secrecy fail** (opz.) | Jailbreak prompt leak — product IP |

**Harness Index score** (esempio):

```
Score = 0.5 * DeepSWE_pass + 0.3 * TB_pass + 0.2 * Honesty_pass
```

Report sempre: `model`, `harness`, `n`, `pass@1 ± CI`, `$/task`.

### D. Runner tecnico per Zelari

Già disponibile:

```bash
zelari-code --headless --mode agent --phase build \
  --task "…" --workdir /repo --provider … --model … --output json
```

Serve:

1. Adapter Harbor/Pier (o script loop) che:
   - monta task repo  
   - lancia Zelari headless  
   - esporta patch / stato  
   - lancia verifier ufficiale  
2. Manifest YAML: `task_id, workdir, prompt, verify_cmd, timeout`  
3. Aggregatore JSON/CSV → tabella harness × model  

**Non** serve entrare nel monorepo AA; serve **stessi task + stessi grader**.

---

## Come presentarlo (onestà)

| Frase sbagliata | Frase corretta |
|-----------------|----------------|
| “Siamo al 40% sull’AA Index” | “Su DeepSWE-subset n=12, **Zelari+Grok** pass@1=X% vs **mini-swe+Grok** Y%” |
| “Migliori di GPT-5.5” | “A parità di model M, Zelari vs scaffold S…” |

Pubblicabile come **blog / whitepaper / internal dashboard**, non come riga ufficiale AA (salvo AA accetti custom agents).

---

## Costo e ordine di lavoro

1. **Settimana 1:** 10 task DeepSWE + adapter headless + mini-swe stesso model  
2. **Settimana 2:** +10 TB + honesty pack + tabella agent vs council (sample)  
3. **Dopo:** full DeepSWE se il delta harness è stabile  

Budget full DeepSWE frontier: **centinaia–migliaia di $** per braccio; parti da subset.

---

## Cosa Zelari può “vincere” vs mini-swe

Non solo pass@1: **false success ↓**, recovery, tool quality, plan/build.  
Se pass@1 è pari ma false success e cost sono migliori, l’indice harness lo deve mostrare.

---

## Sintesi

| Domanda | Risposta |
|---------|----------|
| Posso fare un AA-like index per l’harness? | **Sì**, replica task+grader, fissa i modelli, varia lo scaffold |
| Posso usare il leaderboard AA ufficiale? | **No** come classifica harness; sì come **fonte task/metodologia** |
| Primo passo concreto | Subset DeepSWE + Pier/script + Zelari headless + baseline mini-swe stesso model |

## Riferimenti esterni

- [Artificial Analysis Coding Agents](https://artificialanalysis.ai/agents/coding-agents)
- [DeepSWE](https://deepswe.datacurve.ai/) / [datacurve-ai/deep-swe](https://github.com/datacurve-ai/deep-swe)
- [Pier](https://github.com/datacurve-ai/pier) (Harbor-compatible runner)
- Terminal-Bench / Harbor task format
