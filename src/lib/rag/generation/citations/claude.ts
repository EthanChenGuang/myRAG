import { createHash } from 'node:crypto';
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { streamText, type FilePart, type ModelMessage, type StreamTextResult, type TextPart, type ToolSet } from 'ai';
import { z } from 'zod/v3';
import { CitationRecordSchema, type CitationRecord } from '@/lib/rag-eval/contracts.generated';
import { DEFAULT_ANTHROPIC_BASE_URL } from '../config';
import type { AliasMap } from './blocks';
import { claudeMarkerTransform, type ClaudeCitation } from './claude-transform';
import { createMarkerParser } from './marker-parser';
import { buildCitationRecords } from './record';
import { aliasParserTransform } from './transforms';

export const CLAUDE_MAX_OUTPUT_TOKENS = 16384;

/** Model id prefixes that run adaptive thinking (4.6 and later); budget thinking is never sent on this path (D-10). */
const ADAPTIVE_THINKING_PREFIXES = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-5',
  'claude-fable-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
] as const;

export interface ClaudeProviderOptions {
  apiKey: string;
  baseUrl?: string | null;
  fetch?: typeof fetch;
}

/** Always passes an explicit base URL: an empty ANTHROPIC_BASE_URL would otherwise win inside the provider (research P-3). */
export function createClaudeProvider(options: ClaudeProviderOptions): AnthropicProvider {
  const baseURL = (options.baseUrl?.trim() || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  return createAnthropic({ apiKey: options.apiKey, baseURL, ...(options.fetch ? { fetch: options.fetch } : {}) });
}

export type ClaudeReasoningEligibility = { eligible: true } | { eligible: false; reason: 'reasoning_unsupported' };

export function claudeReasoningEligibility(anthropicId: string): ClaudeReasoningEligibility {
  const id = anthropicId.trim();
  return ADAPTIVE_THINKING_PREFIXES.some((prefix) => id === prefix || id.startsWith(`${prefix}-`))
    ? { eligible: true }
    : { eligible: false, reason: 'reasoning_unsupported' };
}

export interface ClaudeCitationRequestInput {
  provider: AnthropicProvider;
  aliasMap: AliasMap;
  system: string;
  /** Earlier turns, already stripped of markers by the caller. */
  history: ModelMessage[];
  question: string;
  anthropicId: string;
  reasoning?: boolean;
  abortSignal?: AbortSignal;
}

function documentParts(aliasMap: AliasMap): FilePart[] {
  const encoder = new TextEncoder();
  return aliasMap.ordered.map((block) => ({
    type: 'file',
    mediaType: 'text/plain',
    filename: block.alias,
    // Bytes, never a string: a string such as "Document: x" is read as a URL (research P-1).
    data: encoder.encode(block.text),
    providerOptions: { anthropic: { citations: { enabled: true }, title: block.title } },
  }));
}

/**
 * streamText parameters for the direct Claude call (D-09): no output or format option, no sampling
 * parameters, no SDK retries, and documents only in the current user message, in AliasMap order,
 * because the provider resolves document_index positionally.
 */
export function buildClaudeCitationRequest(input: ClaudeCitationRequestInput) {
  const question: TextPart = { type: 'text', text: input.question };
  const thinking =
    input.reasoning === true && claudeReasoningEligibility(input.anthropicId).eligible
      ? { thinking: { type: 'adaptive' as const } }
      : {};
  return {
    model: input.provider(input.anthropicId),
    system: input.system,
    messages: [
      ...input.history,
      { role: 'user', content: [...documentParts(input.aliasMap), question] },
    ] as ModelMessage[],
    maxRetries: 0,
    maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
    providerOptions: { anthropic: { ...thinking } },
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  };
}

export interface ClaudeCitationResult {
  citations: CitationRecord[];
  invalidCitations: number;
}

export interface ClaudeCitationStream {
  result: StreamTextResult<ToolSet, never>;
  /** Validated records with full quotes; the quote is Anthropic's cited_text (D-01). */
  citations(): ClaudeCitationResult;
}

const CitationListSchema = z.array(CitationRecordSchema);

function withCitedQuotes(records: CitationRecord[], quotes: ReadonlyMap<string, string>): CitationRecord[] {
  return records.map((record) => {
    const quote = quotes.get(record.alias);
    if (!quote) return record;
    return { ...record, quote, quoteHash: createHash('sha256').update(quote).digest('hex') };
  });
}

export function startClaudeCitationStream(
  input: ClaudeCitationRequestInput & { tools?: ToolSet },
): ClaudeCitationStream {
  const { aliasMap } = input;
  const parser = createMarkerParser({ aliases: aliasMap.aliases });
  const quotes = new Map<string, string>();
  let unknownSources = 0;
  let failed = false;
  let finished: ClaudeCitationResult | null = null;

  const finalize = (): ClaudeCitationResult => {
    if (finished) return finished;
    if (failed) {
      finished = { citations: [], invalidCitations: 0 };
      return finished;
    }
    try {
      const parsed = parser.finish();
      const records = withCitedQuotes(buildCitationRecords(parsed.valid, aliasMap, 'claude-citations'), quotes);
      finished = {
        citations: CitationListSchema.parse(records),
        invalidCitations: parsed.invalidCitations + unknownSources,
      };
    } catch {
      failed = true;
      finished = { citations: [], invalidCitations: 0 };
    }
    return finished;
  };

  const result = streamText({
    ...buildClaudeCitationRequest(input),
    ...(input.tools ? { tools: input.tools } : {}),
    experimental_transform: [
      claudeMarkerTransform(aliasMap, {
        cite(citation: ClaudeCitation) {
          if (citation.citedText && !quotes.has(citation.alias)) quotes.set(citation.alias, citation.citedText);
        },
        invalid() {
          unknownSources++;
        },
      }),
      aliasParserTransform({
        feed(textId, delta) {
          if (!failed) parser.feed(textId, delta);
        },
        end(textId) {
          if (!failed) parser.end(textId);
        },
        finish() {
          finalize();
        },
        fail() {
          failed = true;
        },
      }),
    ],
  }) as unknown as StreamTextResult<ToolSet, never>;

  return { result, citations: finalize };
}
