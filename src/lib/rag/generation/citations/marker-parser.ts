export interface MarkerParseResult {
  valid: string[];
  invalidCitations: number;
  invalidAliases: string[];
}

export interface MarkerParser {
  feed(textId: string, delta: string): void;
  end(textId: string): void;
  finish(): MarkerParseResult;
}

export function createMarkerParser(_options: { aliases: ReadonlySet<string> }): MarkerParser {
  return {
    feed() {},
    end() {},
    finish: () => ({ valid: [], invalidCitations: 0, invalidAliases: [] }),
  };
}

export function parseAnswerMarkers(_text: string, _aliases: ReadonlySet<string>): MarkerParseResult {
  return { valid: [], invalidCitations: 0, invalidAliases: [] };
}
