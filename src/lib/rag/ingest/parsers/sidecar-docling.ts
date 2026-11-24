import type { Sleep } from './shared';
import type { DocumentParser } from './shared';
import { ParserError } from './shared';

export interface SidecarConfig {
  baseUrl: string;
  secret: string;
  requestTimeoutMs?: number;
  sleep?: Sleep;
}

export type SidecarInputFormat = 'pdf' | 'docx' | 'html' | 'image';

export function inputFormatFor(_filename: string, _mimeType: string): SidecarInputFormat | null {
  return null;
}

export function createSidecarParser(_config: SidecarConfig): DocumentParser {
  return {
    name: 'docling',
    unavailableReason: () => null,
    async parse() {
      return { kind: 'pending', job: { parser: 'docling', jobId: 'stub', submittedAt: '', attempt: 1 } };
    },
  };
}

const unavailable: DocumentParser = {
  name: 'docling',
  unavailableReason: () => 'not_configured',
  async parse() {
    throw new ParserError('docling', 'not_configured');
  },
};

let override: DocumentParser | null = null;

export function getSidecarParser(): DocumentParser {
  return override ?? unavailable;
}

export function setSidecarParserForTests(parser: DocumentParser): void {
  override = parser;
}

export function resetSidecarParserForTests(): void {
  override = null;
}
