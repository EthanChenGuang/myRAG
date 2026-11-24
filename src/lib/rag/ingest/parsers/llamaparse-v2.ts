import type { DocumentParser } from './shared';
import { ParserError } from './shared';

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
