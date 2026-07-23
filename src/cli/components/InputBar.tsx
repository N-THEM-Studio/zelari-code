import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
}

/**
 * Input bar — the user prompt editor at the bottom of the TUI.
 *
 * Performance: React.memo with custom comparator. `onChange` and `onSubmit`
 * are arrow functions created in App's render (line 2183-2185) which would
 * defeat React.memo's default shallow equal. The custom comparator ignores
 * those function identities — the InputBar re-renders only when value or
 * disabled actually change. This stops the input cursor from being reset on
 * every streaming token delta from the LLM (visible jitter on the bottom
 * row of the terminal).
 */
function InputBarImpl({ value, onChange, onSubmit, disabled }: InputBarProps): React.ReactElement {
  // The App-level React.memo comparator intentionally ignores onChange/onSubmit
  // identity changes (those are fresh closures every App render). To still
  // pick up the latest closures inside the (sometimes-skipped) memo'd
  // render, mirror them through refs that are always read at call-time.
  // v0.4.3 audit fix: without this, typing a long prompt while the parent
  // re-renders (e.g. on streaming tokens) would route /submit through a
  // stale closure capturing pre-stream values of messages/sessionId/etc.
  const onSubmitRef = React.useRef(onSubmit);
  const onChangeRef = React.useRef(onChange);
  onSubmitRef.current = onSubmit;
  onChangeRef.current = onChange;
  const stableSubmit = React.useCallback((v: string) => onSubmitRef.current(v), []);
  const stableChange = React.useCallback((v: string) => onChangeRef.current(v), []);

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="cyan" bold>❯ </Text>
      <TextInput
        value={value}
        onChange={stableChange}
        onSubmit={stableSubmit}
        placeholder={disabled ? '...' : 'Prompt, /skills, or @path'}
      />
    </Box>
  );
}

export const InputBar = React.memo(InputBarImpl, (prev, next) => {
  return (
    prev.value === next.value &&
    prev.disabled === next.disabled
    // onChange/onSubmit identity changes ignored: App passes fresh arrows each
    // render. The TextInput handles its own internal state; re-binding to the
    // new closures is safe.
  );
});
