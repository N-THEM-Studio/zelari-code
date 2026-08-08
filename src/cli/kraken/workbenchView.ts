/**
 * Kraken workbench — pure parser + renderer (F3.2 TUI viewer).
 *
 * The workbench writer (`workbench.ts`) produces a Markdown file. This
 * module parses that file back into a structured form and renders it as
 * a text block suitable for the TUI (Ink) transcript or a tail-able
 * text view.
 *
 * The parser is **deliberately tolerant**: a partial or truncated file
 * (mid-write, mid-rename) must not throw. Missing sections render as
 * empty rather than as a stack trace.
 *
 * @since Kraken v1.30.x — workflow script runtime (Pillar 3 F3.2)
 */

export interface ParsedWorkbenchNode {
  id: string;
  label: string;
  kind: string;
  scope: string;
  status: string;
  model: string;
  duration: string;
}

export interface ParsedWorkbench {
  goal: string;
  graphId: string;
  started: string;
  elapsed: string;
  progress: string;
  nodes: ParsedWorkbenchNode[];
  events: { ts: string; text: string }[];
}

const EMPTY: ParsedWorkbench = {
  goal: '',
  graphId: '',
  started: '',
  elapsed: '',
  progress: '',
  nodes: [],
  events: [],
};

/** Parse a workbench Markdown file into a structured form. Tolerant. */
export function parseWorkbench(content: string | undefined | null): ParsedWorkbench {
  if (!content) return { ...EMPTY, nodes: [], events: [] };
  const lines = content.split(/\r?\n/);
  const out: ParsedWorkbench = { ...EMPTY, nodes: [], events: [] };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Header: `**Goal:**`, `**Graph id:**`, `**Started:** ... · **Elapsed:** ...`
    const goalM = /^\*\*Goal:\*\*\s*(.*)$/.exec(line);
    if (goalM) { out.goal = goalM[1]; i += 1; continue; }
    const gidM = /^\*\*Graph id:\*\*\s*`?([^`\s]*)`?/.exec(line);
    if (gidM) { out.graphId = gidM[1]; i += 1; continue; }
    const startedM = /^\*\*Started:\*\*\s*(.+?)\s*·\s*\*\*Elapsed:\*\*\s*(\S+)/.exec(line);
    if (startedM) {
      out.started = startedM[1];
      out.elapsed = startedM[2];
      i += 1;
      continue;
    }
    const justStarted = /^\*\*Started:\*\*\s*(.*)$/.exec(line);
    if (justStarted) {
      out.started = justStarted[1];
      i += 1;
      continue;
    }

    // Section header: `## Section` or `## Section: data`. The section name
    // is anything up to the first whitespace or colon, so `## Progress: 2/5`
    // gives section='Progress', inline='2/5'; `## Events (latest 30)` gives
    // section='Events' and the `(latest 30)` is dropped. No `$` anchor:
    // when the inline group doesn't match (no `:` after the section name),
    // an anchored `$` would require the regex to be at end-of-line, which
    // it isn't because the section name is followed by a space.
    const sectionM = /^##\s+([^:\s]+)(?::\s*(.*))?/.exec(line);
    if (!sectionM) { i += 1; continue; }
    const section = sectionM[1];
    const inline = sectionM[2] ?? '';

    if (section === 'Progress') {
      if (inline) out.progress = inline;
      i += 1;
      continue;
    }
    if (section === 'Wave') {
      // Skip until the first DATA row (starts with `| t`), not just any
      // `|`. The header row `| id | label | ...` does not match `| t` so we
      // walk past it cleanly. Tolerates blank lines between the section
      // header and the table.
      while (i < lines.length && !lines[i].startsWith('| t')) i += 1;
      // Read data rows.
      while (i < lines.length && lines[i].startsWith('| t')) {
        const cells = splitRow(lines[i]);
        if (cells.length >= 7) {
          out.nodes.push({
            id: cells[0],
            label: cells[1],
            kind: cells[2],
            scope: cells[3],
            status: cells[4],
            model: cells[5],
            duration: cells[6],
          });
        }
        i += 1;
      }
      continue;
    }
    if (section === 'Events' || section.startsWith('Events')) {
      // Skip blank lines between the section header and the first event.
      while (i < lines.length && !lines[i].startsWith('- ')) i += 1;
      while (i < lines.length && lines[i].startsWith('- ')) {
        const m = /^-\s+(\d{2}:\d{2}:\d{2})\s+(.*)$/.exec(lines[i]);
        if (m) out.events.push({ ts: m[1], text: m[2] });
        i += 1;
      }
      continue;
    }
    // Unknown section: skip.
    i += 1;
  }

  return out;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Render a parsed workbench as a fixed-width text block. */
export function formatWorkbenchForTerminal(p: ParsedWorkbench): string {
  const lines: string[] = [];
  if (p.goal) lines.push(`[kraken] ${p.goal}`);
  if (p.progress) lines.push(`[kraken] progress: ${p.progress}`);
  if (p.elapsed) lines.push(`[kraken] elapsed: ${p.elapsed}`);
  lines.push('');
  if (p.nodes.length > 0) {
    lines.push('[kraken] wave:');
    for (const n of p.nodes) {
      const scope = n.scope ? ` (${n.scope})` : '';
      const dur = n.duration ? ` ${n.duration}` : '';
      lines.push(`  ${n.status}  ${n.id}  ${n.label}${scope}${dur ? ' ' + dur : ''}`);
    }
    lines.push('');
  }
  if (p.events.length > 0) {
    lines.push('[kraken] events (latest):');
    for (const e of p.events.slice(-10)) {
      lines.push(`  ${e.ts}  ${e.text}`);
    }
  }
  return lines.join('\n');
}
