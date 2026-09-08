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
import { responsesApiProvider } from './responsesApi.js';
import { getApiStyleFor } from '../providerConfig.js';

export function buildProviderStream(config: OpenAICompatibleConfig): ProviderStreamFn {
  if (config.providerId === 'anthropic') return anthropicMessagesProvider(config);
  if (config.providerId === 'chatgpt') return chatgptResponsesProvider(config);
  // Endpoint-style override: any OpenAI-compatible provider can be switched
  // to the Responses API (`POST /responses`) via `/provider api responses`.
  // The selection is persisted per-provider (providerConfig.apiStyleByProvider).
  if (getApiStyleFor(config.providerId) === 'responses') {
    return responsesApiProvider(config);
  }
  return openaiCompatibleProvider(config);
}
