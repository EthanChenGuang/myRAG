import { env } from '@/lib/env';

/** The chat route's per-model output limit, moved here unchanged so the prompt budget can read it before retrieval. */
export function getMaxTokensForModel(modelId: string): number {
  // Check for environment variable override
  if (env.MAX_COMPLETION_TOKENS) {
    const envLimit = parseInt(env.MAX_COMPLETION_TOKENS);
    if (!isNaN(envLimit) && envLimit > 0) {
      console.log('API ROUTE: Using MAX_COMPLETION_TOKENS from env:', envLimit);
      return envLimit;
    }
  }

  // Specific limits for Claude 4 models (newer generation with higher capacity)
  if (modelId.includes('claude-sonnet-4') || modelId.includes('claude-4-sonnet')) {
    console.log('API ROUTE: Using Claude Sonnet 4 token limit: 16384');
    return 16384; // Conservative but sufficient for most responses (actual max is 64K)
  }
  if (modelId.includes('claude-opus-4') || modelId.includes('claude-4-opus')) {
    console.log('API ROUTE: Using Claude Opus 4 token limit: 16384');
    return 16384; // Conservative limit for Opus 4 (actual max is 32K)
  }

  // Specific limits for Claude 3.7/3.8 models
  if (modelId.includes('claude-3.7') || modelId.includes('claude-3.8')) {
    console.log('API ROUTE: Using Claude 3.7/3.8 token limit: 8192');
    return 8192; // Higher limit for newer Claude 3 models
  }

  // Default for other Claude/Anthropic models
  if (modelId.includes('claude') || modelId.includes('anthropic')) {
    console.log('API ROUTE: Using default Claude model token limit: 4096');
    return 4096; // Safe limit for older Claude models
  }

  // GPT models
  if (modelId.includes('gpt-5-mini')) {
    console.log('API ROUTE: Using GPT-5-mini token limit: 8192');
    return 8192; // Higher limit for cheaper model
  }
  if (modelId.includes('gpt-5')) {
    console.log('API ROUTE: Using GPT-5 token limit: 4096');
    return 4096; // Conservative default
  }
  if (modelId.includes('gpt-4.1-mini')) {
    console.log('API ROUTE: Using GPT-4.1-mini token limit: 8192');
    return 8192; // Higher limit for cheaper model
  }
  if (modelId.includes('gpt-4.1')) {
    console.log('API ROUTE: Using GPT-4.1 token limit: 4096');
    return 4096; // Standard limit
  }

  // Llama models
  if (modelId.includes('llama')) {
    console.log('API ROUTE: Using Llama model token limit: 4096');
    return 4096; // Standard limit for Llama
  }

  // Default for unknown models
  console.log('API ROUTE: Using default token limit: 4096');
  return 4096;
}
