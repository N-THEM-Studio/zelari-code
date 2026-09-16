import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useInputDraft, type InputDraftStore } from './inputDraft.js';

export interface InputBarProps {
  /**
   * Prompt draft store. The draft is NOT a prop value: a keystroke writes the
   * store and re-renders ONLY this bar, never the app tree around it
   * (diagnosi 2026-09-15, slice 5). `App` writes the same store to clear the
   * prompt after a submit/slash command.
   */
  draft: InputDraftStore;
  onSubmit: (value: string) => void;
  disabled?: boolean;
}

/**
 * Input bar — the user prompt editor at the bottom of the TUI.
 *
 * Performance: React.memo with an explicit comparator over the two props that
 * actually change the painted bar (`draft` identity + `disabled`). `onSubmit`
 * is a fresh closure on every App render, so its identity is deliberately
 * ignored; the latest one is mirrored through a ref and read at call time
 * (v0.4.3 audit fix: a stale closure would route /submit with pre-stream
 * values of messages/sessionId). The cursor therefore survives streaming
 * token deltas — nothing re-renders this bar unless the draft or the disabled
 * state really changed.
 */
function InputBarImpl({ draft, onSubmit, disabled }: InputBarProps): React.ReactElement {
  const value = useInputDraft(draft);

  const onSubmitRef = React.useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const stableSubmit = React.useCallback((v: string) => onSubmitRef.current(v), []);

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="cyan" bold>❯ </Text>
      <TextInput
        value={value}
        onChange={draft.set}
        onSubmit={stableSubmit}
        placeholder={disabled ? '...' : 'Prompt, /skills, or @path'}
      />
    </Box>
  );
}

/** Explicit comparator — exported so the contract is pinned by a test. */
export function inputBarPropsEqual(prev: InputBarProps, next: InputBarProps): boolean {
  return prev.draft === next.draft && prev.disabled === next.disabled;
}

export const InputBar = React.memo(InputBarImpl, inputBarPropsEqual);
