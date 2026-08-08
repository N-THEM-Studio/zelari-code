/**
 * BennettsRazorExplainer - inline pill + modal that surfaces Bennett's Razor
 * (arXiv:2301.12987) to the user whenever Kraken Graph mode is on.
 *
 * Why: Zelari is the only coding-agent CLI that applies Bennett's
 * weakness-based hypothesis ranking (ADR 013, Slice L) — but the user
 * has no way to know that today. This component turns the implicit
 * "weaker plan wins among ties" behavior into an explicit feature the
 * user can read about, opt out of (via the ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR
 * env var, surfaced as a note), and evangelize to teammates.
 *
 * Design constraints:
 *  - Zero new deps (no react-modal, no headlessui)
 *  - Inline pill appears only when `visible` is true, so it never adds
 *    visual weight to non-Kraken runs
 *  - Modal uses native <div role="dialog"> + Escape-to-close + click-outside
 *  - The paper PDF is shipped with the repo at
 *    `.zelari/docs/papers/2301.12987v4.pdf`; we link to the arXiv abstract
 *    (canonical) so the link works even outside the repo
 *
 * @since v1.31.x - Bennett's Razor UI surface (Slice N / desktop)
 */

import { useCallback, useEffect, useState } from "react";

interface Props {
  /** True when Kraken Graph mode is active. The pill only renders when true. */
  visible: boolean;
}

const PAPER_URL = "https://arxiv.org/abs/2301.12987";
const PAPER_TITLE = "The Optimal Choice of Hypothesis Is the Weakest, Not the Shortest";
const PAPER_AUTHOR = "Michael Timothy Bennett";
const PAPER_VENUE = "AGI 2023";
const PAPER_BENNETTS_RAZOR = "Explanations should be no more specific than necessary.";

export function BennettsRazorExplainer({ visible }: Props) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // Escape closes the modal — matches the OS-level "press Escape to dismiss"
  // muscle memory. Native <dialog> would do this for free, but we use a
  // div+role so the rest of the app doesn't need to learn the dialog API.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!visible) return null;

  return (
    <>
      <button
        type="button"
        className="razor-pill"
        title="Bennett's Razor is active in this run. Click to learn how it ranks weaker plans first."
        onClick={() => setOpen(true)}
        aria-label="Open Bennett's Razor explainer"
      >
        <span className="razor-pill-icon" aria-hidden="true">🪒</span>
        <span className="razor-pill-text">Bennett's Razor</span>
      </button>

      {open ? (
        <div
          className="razor-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="razor-modal-title"
          onClick={(e) => {
            // Click on the backdrop (not the dialog body) closes.
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="razor-modal">
            <header className="razor-modal-head">
              <div className="razor-modal-title-wrap">
                <span className="razor-modal-icon" aria-hidden="true">🪒</span>
                <h2 id="razor-modal-title" className="razor-modal-title">
                  Bennett's Razor
                </h2>
              </div>
              <button
                type="button"
                className="btn-ghost razor-modal-close"
                onClick={close}
                aria-label="Close"
                title="Close (Escape)"
              >
                ×
              </button>
            </header>

            <div className="razor-modal-body">
              <p className="razor-modal-pull">
                <em>"{PAPER_BENNETTS_RAZOR}"</em>
              </p>

              <p>
                When two plans would both solve your task, Kraken prefers the one that
                <strong> assumes the least</strong> — fewer pinned paths, fewer exact
                versions, fewer invariants about external state. The hypothesis with
                the larger extension generalises better, and Bennett's experiments on
                binary 8-bit arithmetic showed a <strong>1.1×–5× higher generalisation
                rate</strong> vs. minimum description length (Occam's Razor as length).
              </p>

              <h3>How it shows up in this run</h3>
              <ul>
                <li>
                  The planner receives a tie-breaker directive (opt-in via the
                  <code> ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR </code>
                  env var). Default-on from v1.32.x.
                </li>
                <li>
                  Each <code>verify</code> / <code>spec</code> / <code>conformance</code>
                  reviewer surfaces a Bennett weakness score in
                  <code> .zelari/radio/workbench-&lt;id&gt;.md</code>: 1.0 = the
                  reviewer asserted nothing (loose), 0.0 = pinned every value (tight).
                </li>
                <li>
                  A <code>PASS</code> with weakness 0.31 is "tightly asserted"; a
                  <code> PASS</code> with weakness 0.92 is "loosely claimed". Treat
                  the two differently when you skim the digest.
                </li>
              </ul>

              <h3>Why this matters for LLM agents</h3>
              <p>
                LLMs are trained to minimise cross-entropy, which rewards being
                <em> specific</em> — the opposite of weakness. Bennett himself wrote:
                <em> "The reason why LLMs are so prone to fabrication and inconsistency
                may be because they are optimised only to minimise loss, rather than
                maximise weakness."</em> Zelari is, to our knowledge, the only coding-agent
                CLI that operationalises this at the orchestration layer.
              </p>

              <footer className="razor-modal-foot">
                <span className="razor-paper-cite">
                  {PAPER_AUTHOR} ({PAPER_VENUE}). <em>{PAPER_TITLE}</em>.
                  <a href={PAPER_URL} target="_blank" rel="noreferrer" className="razor-paper-link">
                    arXiv:2301.12987
                  </a>
                </span>
              </footer>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
