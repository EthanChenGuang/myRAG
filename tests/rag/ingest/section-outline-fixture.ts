import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OUTLINE = {
  id: 'neutral-sheet',
  version: 1,
  detect: { pattern: 'Widget Sheet', within_chars: 200 },
  sections: [
    { key: '1', level: 1, pattern: '1\\s+Name' },
    { key: '2', level: 1, pattern: '2\\s+Scope' },
    { key: '2.1', level: 2, pattern: '2\\.1\\s+Details' },
    { key: '3', level: 1, pattern: '3\\s+Notes' },
  ],
  variant_start: '1',
  cross_ref_prefixes: ['see section', 'see'],
  toc: { max_span_chars: 80 },
};

export const outlineFile = (outlines: unknown[] = [OUTLINE]) => ({ schema_version: 1, outlines });

export const ALPHA_LABEL = 'Alpha Widget, blue';
export const BETA_LABEL = 'Beta Widget, green';

export const ALPHA =
  '1 Name Alpha Widget, blue. The alpha widget is a small sample part used only to fill this synthetic sheet with text. ' +
  '2 Scope The scope of the alpha widget covers bench tests and shelf storage in a plain sample room for parts. ' +
  '2.1 Details The details of the alpha widget list its size, its weight and its colour, see section 3 Notes for more of it. ' +
  '3 Notes The notes on the alpha widget say that it is a plain example part and that it holds no real data at all.';

export const BETA =
  '1 Name Beta Widget, green. The beta widget is a second sample part used only to fill this synthetic sheet with text. ' +
  '2 Scope The scope of the beta widget covers bench tests and shelf storage in a plain sample room for its parts. ' +
  '2.1 Details The details of the beta widget list its size, its weight and its colour in one plain row of text. ' +
  '3 Notes The notes on the beta widget say that it is a plain example part and that it holds no real data at all.';

export const TITLE = 'Widget Sheet Collection';
export const CONTENTS = 'Contents 1 Name 2 Scope 2.1 Details 3 Notes';

export const DOCUMENT = [TITLE, CONTENTS, ALPHA, BETA, ''].join('\n');

export const SECTION_PATHS = (label: string): string[][] => [
  [label, '1 Name'],
  [label, '2 Scope'],
  [label, '2 Scope', '2.1 Details'],
  [label, '3 Notes'],
];

export function writeOutlineFile(content: unknown, name = 'outline.json'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'section-outline-'));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}
