import { describe, expect, it } from 'vitest';
import { buildClaudeContextReplacement, docsFromBlocks, wrapDocuments } from '@/lib/rag/context/wrap';
import type { ContextBlock } from '@/lib/rag/types';

const CASES = 20_000;
const SEED = 0x5eed0501;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cp = (...points: number[]) => String.fromCodePoint(...points);
const tagChars = (ascii: string) => Array.from(ascii, (ch) => cp(0xe0000 + ch.charCodeAt(0))).join('');
const fullWidth = (ascii: string) => Array.from(ascii, (ch) => cp(ch.charCodeAt(0) + 0xfee0)).join('');
const LT = [ '<', cp(0xff1c), cp(0xfe64), tagChars('<') ];
const GT = [ '>', cp(0xff1e), cp(0xfe65), tagChars('>') ];

const ATOMS: string[] = [
  '<doc>',
  '</doc>',
  '</ DOC >',
  '<doc id="x">',
  '<doc/>',
  '<documents>',
  '</documents>',
  '< / Documents >',
  `${cp(0xff1c)}doc${cp(0xff1e)}`,
  `${cp(0xfe64)}/doc${cp(0xfe65)}`,
  `${cp(0xff1c)}/documents${cp(0xff1e)}`,
  `<d${cp(0x200b)}oc>`,
  `</do${cp(0x2060)}c>`,
  `<${cp(0x00ad)}doc${cp(0xfeff)}>`,
  `<${cp(0x202e)}/doc>`,
  `<${fullWidth('doc')}>`,
  `</${fullWidth('DOCUMENTS')}>`,
  `<${tagChars('doc')}>`,
  tagChars('</doc>'),
  tagChars('<documents>'),
  '<!-- </doc> -->',
  '<tool_result x>',
  '</tool-result>',
  '<TOOL_RESULT>',
  `<${cp(0x0338)}doc>`,
  '</doc',
  '<doc',
  'x"><doc id="evil',
  '" onload="',
  '&amp;',
  '&lt;doc&gt;',
  '&',
  '"',
  "'",
  '<docs>',
  '<document>',
  '<br>',
  '| a < 5 | b > 3 |',
  'plain words',
  '\n',
  '  ',
  '中文内容',
  cp(0x1f600),
  cp(0xfb01),
];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function randomText(rng: () => number, maxAtoms: number): string {
  const n = Math.floor(rng() * maxAtoms);
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const roll = rng();
    if (roll < 0.1) out += `${pick(rng, LT)}${rng() < 0.5 ? '/' : ''}${pick(rng, ['doc', 'DOC', 'documents', 'tool_result'])}${pick(rng, GT)}`;
    else out += pick(rng, ATOMS);
  }
  return out;
}

function randomBlocks(rng: () => number): ContextBlock[] {
  const count = 1 + Math.floor(rng() * 6);
  const blocks: ContextBlock[] = [];
  let alias = 0;
  for (let i = 0; i < count; i += 1) {
    const isImage = rng() < 0.2;
    const aliased = !isImage && rng() < 0.5;
    blocks.push({
      documentId: `d${i}`,
      documentName: randomText(rng, 4) || 'name.pdf',
      documentVersion: 1,
      chunkIds: [`k${i}`],
      page: null,
      sectionPath: rng() < 0.4 ? [randomText(rng, 3), randomText(rng, 2)] : null,
      title: 'title',
      text: randomText(rng, 12),
      isImage,
      alias: aliased ? `S${++alias}` : null,
    });
  }
  return blocks;
}

const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

/** A lenient reader: decodes tag characters, removes invisibles, NFKC, case-folds. */
function lenient(text: string): string {
  const decoded = Array.from(text, (ch) => {
    const code = ch.codePointAt(0)!;
    if (code >= 0xe0020 && code <= 0xe007e) return String.fromCharCode(code - 0xe0000);
    if (code >= 0xe0000 && code <= 0xe007f) return '';
    return ch;
  }).join('');
  return decoded.replace(INVISIBLE, '').normalize('NFKC').toLowerCase();
}

function countTags(text: string) {
  const view = lenient(text);
  return {
    docOpen: view.match(/<\s*doc(?![a-z0-9_-])[^<>]*>/g)?.length ?? 0,
    docClose: view.match(/<\s*\/\s*doc(?![a-z0-9_-])[^<>]*>/g)?.length ?? 0,
    docsOpen: view.match(/<\s*documents(?![a-z0-9_-])[^<>]*>/g)?.length ?? 0,
    docsClose: view.match(/<\s*\/\s*documents(?![a-z0-9_-])[^<>]*>/g)?.length ?? 0,
    toolResult: view.match(/<\s*\/?\s*tool[-_]result(?![a-z0-9_-])/g)?.length ?? 0,
  };
}

describe('wrapDocuments escape property', () => {
  it(`keeps exactly N doc elements and one documents pair over ${CASES} seeded cases`, () => {
    const rng = mulberry32(SEED);
    const failures: string[] = [];
    for (let index = 0; index < CASES; index += 1) {
      const blocks = randomBlocks(rng);
      const links = rng() < 0.3 ? randomText(rng, 5) : undefined;
      const flagged = new Set(blocks.filter(() => rng() < 0.2).flatMap((b) => b.chunkIds));
      const docs = docsFromBlocks(blocks, { links, flaggedChunkIds: flagged });
      const out = wrapDocuments(docs, { toolResults: rng() < 0.3 });
      const n = docs.length;
      const tags = out === null ? null : countTags(out);
      if (
        tags === null ||
        tags.docOpen !== n ||
        tags.docClose !== n ||
        tags.docsOpen !== 1 ||
        tags.docsClose !== 1 ||
        tags.toolResult !== 0
      ) {
        failures.push(`case ${index}: expected ${n} docs, got ${JSON.stringify(tags)}`);
      }

      if (index % 10 === 0) {
        const claude = buildClaudeContextReplacement({ attachedSentence: 'Attached.', docs });
        const side = docs.filter((doc) => doc.kind === 'image' || doc.kind === 'links').length;
        const c = countTags(claude);
        const pair = side > 0 ? 1 : 0;
        if (c.docOpen !== side || c.docClose !== side || c.docsOpen !== pair || c.docsClose !== pair) {
          failures.push(`claude case ${index}: expected ${side} docs, got ${JSON.stringify(c)}`);
        }
      }
      if (failures.length >= 5) break;
    }
    expect(failures).toEqual([]);
  });
});
