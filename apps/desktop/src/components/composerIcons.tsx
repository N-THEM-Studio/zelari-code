/**
 * Inline composer glyphs. Pulled out of Composer.tsx so the composer file
 * stays within the house size budget and the icons stay pure/reusable.
 */

export function AttachIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
      <path
        fill="currentColor"
        d="M16.5 6.5v10a4.5 4.5 0 1 1-9 0V7a3 3 0 1 1 6 0v9.5a1.5 1.5 0 1 1-3 0V8H12v8.5a3 3 0 1 0 6 0V6.5a4.5 4.5 0 1 0-9 0V16a6 6 0 1 0 12 0V7h-1.5z"
      />
    </svg>
  );
}

export function SkillsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
      <path
        fill="currentColor"
        d="M12 2l2.4 7.2H22l-6 4.4 2.3 7.2L12 16.8 5.7 20.8 8 13.6 2 9.2h7.6L12 2z"
      />
    </svg>
  );
}

export function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
      />
    </svg>
  );
}

export function SendArrowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12h16M13 6l6 6-6 6" />
    </svg>
  );
}

export function SendArrowUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}
