import type { DocumentParser } from './shared';
import { ParserError } from './shared';

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
