export const IDENTIFIER_PATTERN = /(?!)/gu;

export interface IdentifierSplit {
  text: string;
  identifier: boolean;
}

export function splitAtIdentifiers(text: string): IdentifierSplit[] {
  return [{ text, identifier: false }];
}

export function extractIdentifiers(_text: string): string[] {
  return [];
}
