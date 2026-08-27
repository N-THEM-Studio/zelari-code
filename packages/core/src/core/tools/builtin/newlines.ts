/**
 * Newline helpers for edit/patch tools.
 *
 * Windows working trees are often CRLF while the model emits LF in
 * `oldString` / unified diffs. Matching must ignore that difference and
 * writes must restore the file's original terminator so git doesn't see
 * a whole-file line-ending change.
 */

export type Newline = '\r\n' | '\n' | '\r';

export function detectNewline(text: string): Newline {
  if (text.includes('\r\n')) return '\r\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}

export function toLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function fromLF(text: string, nl: Newline): string {
  if (nl === '\n') return text;
  return text.replace(/\n/g, nl);
}

/** Split on any newline, dropping the terminator (same shape as `String.split('\\n')`). */
export function splitLinesLF(text: string): string[] {
  return toLF(text).split('\n');
}
