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
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="cyan" bold>❯ </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={disabled ? '...' : 'Type a prompt or /skill <name>'}
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
