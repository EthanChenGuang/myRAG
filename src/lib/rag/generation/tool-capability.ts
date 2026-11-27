const TOOL_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'openrouter', 'groq']);

export interface ToolCapabilityInput {
  /** NEXT_PUBLIC_AI_PROVIDER of the deployment. */
  provider: string | null | undefined;
  modelId: string;
}

/** The chat route's `isClaudeSonnet4` rule: tool calls are switched off for the three claude-sonnet-4 id forms. */
export function modelBlocksTools(modelId: string): boolean {
  return modelId.includes('claude-sonnet-4') || modelId.includes('claude-4-sonnet') || modelId.includes('anthropic/claude-sonnet-4');
}

/**
 * D-70, D-72: the chat route's current tool rule as one predicate (`SUPPORTS_TOOLS && !isClaudeSonnet4`): tools only for the
 * openai, openrouter and groq providers and never for a claude-sonnet-4 model id. A false turn uses the trailing block.
 */
export function turnCanUseTools(input: ToolCapabilityInput): boolean {
  return typeof input.provider === 'string' && TOOL_PROVIDERS.has(input.provider) && !modelBlocksTools(input.modelId);
}
