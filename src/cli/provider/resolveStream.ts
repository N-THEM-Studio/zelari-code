/**
 * resolveStream — pick the HTTP adapter for the active provider.
 */
import type { ProviderStreamFn } from '@zelari/core/harness';
import {
  openaiCompatibleProvider,
  type OpenAICompatibleConfig,
} from './openai-compatible.js';
import { anthropicMessagesProvider } from './anthropic.js';
import { chatgptResponsesProvider } from './chatgpt.js';

export function buildProviderStream(config: OpenAICompatibleConfig): ProviderStreamFn {
  if (config.providerId === 'anthropic') return anthropicMessagesProvider(config);
  if (config.providerId === 'chatgpt') return chatgptResponsesProvider(config);
  return openaiCompatibleProvider(config);
}
