import { ParserError, type DocumentParser } from './shared';

export interface ImagePolicy {
  hostAllowed: (host: string) => boolean;
  allowInsecure?: boolean;
}

export interface LlamaParseConfig {
  baseUrl: string;
  apiKey: string;
  tier: 'fast' | 'cost_effective' | 'agentic';
  requestTimeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  imagePolicy?: ImagePolicy;
}

export function isAllowedImageUrl(_url: string, _policy?: ImagePolicy): boolean {
  return false;
}

export function tierFor(_mode: string): LlamaParseConfig['tier'] {
  return 'fast';
}

export function createLlamaParseParser(_config: LlamaParseConfig): DocumentParser {
  return {
    name: 'llamaparse',
    unavailableReason: () => null,
    async parse() {
      return { kind: 'pending', job: { parser: 'llamaparse', jobId: 'stub', submittedAt: '', attempt: 1 } };
    },
  };
}

const unavailable: DocumentParser = {
  name: 'llamaparse',
  unavailableReason: () => 'not_configured',
  async parse() {
    throw new ParserError('llamaparse', 'not_configured');
  },
};

let override: DocumentParser | null = null;

export function getLlamaParseParser(): DocumentParser {
  return override ?? unavailable;
}

export function setLlamaParseParserForTests(parser: DocumentParser): void {
  override = parser;
}

export function resetLlamaParseParserForTests(): void {
  override = null;
}
