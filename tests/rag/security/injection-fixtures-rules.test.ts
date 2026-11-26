import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { scanText } from '@/lib/rag/security/injection-rules';
import { resetInjectionRulesForTests } from '@/lib/rag/security/injection-scan';
import { loadCorpus, type CorpusDocument } from '../../../eval/harness/corpus.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const CANARY_RE = /ZXQ-CANARY-\d{4}/g;
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');

interface GoldenAttackLine {
  id: string;
  category: string;
  language: string;
  attack?: { canary: string; injected_quotes: Array<{ document: string; section: string; quote: string }> };
}

type AttackClass = 'rules' | 'evasive';

/** Per language, the sec-attacks headings in file order with their class (D-13): four the rules catch, two that paraphrase around them. */
const ATTACKS: Record<string, Array<[heading: string, expected: AttackClass]>> = {
  zh: [
    ['青岚 LM-77 折叠台灯 读者留言', 'rules'],
    ['星湾 TS-12 陶瓷茶具 读者留言', 'rules'],
    ['云栖 BN-8 观鸟望远镜 读者留言', 'rules'],
    ['松果社区图书馆 读者留言', 'rules'],
    ['橙舟 KY-40 皮划艇 读者留言', 'evasive'],
    ['雾山 CG-5 磨豆机 读者留言', 'evasive'],
  ],
  en: [
    ['Fernwick DL-77 folding desk lamp reader comment', 'rules'],
    ['Harlow Bay TS-12 porcelain tea set reader comment', 'rules'],
    ['Cloudmere BN-8 birding binoculars reader comment', 'rules'],
    ['Pinecone Community Library reader comment', 'rules'],
    ['Tangerine Skiff KY-40 kayak reader comment', 'evasive'],
    ['Mistpeak CG-5 coffee grinder reader comment', 'evasive'],
  ],
  it: [
    ['Lampada pieghevole Fiordaliso LP-77 commento dei lettori', 'rules'],
    ['Servizio da tè Baia Serena TS-12 commento dei lettori', 'rules'],
    ['Binocolo Nuvolaria BN-8 commento dei lettori', 'rules'],
    ['Biblioteca di quartiere Pigna commento dei lettori', 'rules'],
    ['Kayak Mandarino KY-40 commento dei lettori', 'evasive'],
    ['Macinacaffè Montenebbia CG-5 commento dei lettori', 'evasive'],
  ],
};

const loadedCorpus = loadCorpus(CORPUS_DIR);

/** The named fixture document; a missing one fails the calling test on an assertion. */
function documentNamed(relpath: string): CorpusDocument {
  const document = loadedCorpus.documents.find((entry) => entry.relpath === relpath);
  expect(document, `fixture document ${relpath}`).toBeDefined();
  return document as CorpusDocument;
}

afterEach(() => {
  resetInjectionRulesForTests();
});

describe('injection fixture documents against the shipped rules (D-13, D-14)', () => {
  for (const [language, attacks] of Object.entries(ATTACKS)) {
    describe(language, () => {
      const attackPath = `${language}/sec-attacks.${language}.md`;
      const topicPath = `${language}/sec-topics.${language}.md`;

      test('sec-attacks has the pinned headings in order, one chunk each, with one unique canary per chunk', () => {
        const attackDoc = documentNamed(attackPath);
        expect(attackDoc.chunks.map((chunk) => chunk.section)).toEqual(attacks.map(([heading]) => heading));
        for (const chunk of attackDoc.chunks) {
          expect(chunk.text.match(CANARY_RE) ?? [], chunk.section).toHaveLength(1);
          expect(chunk.text, `${chunk.section} keeps tag brackets out of the injected text`).not.toMatch(/[<>]/);
        }
      });

      for (const [index, [heading, expected]] of attacks.entries()) {
        test(`${heading} is ${expected === 'rules' ? 'caught by at least one rule' : 'not caught by any rule'}`, () => {
          const chunk = documentNamed(attackPath).chunks[index];
          expect(chunk?.section).toBe(heading);
          const result = scanText(chunk?.text ?? '');
          if (expected === 'rules') {
            expect(result.matched, heading).toBe(true);
            expect(result.rule_ids.length).toBeGreaterThan(0);
          } else {
            expect(result.rule_ids, heading).toEqual([]);
            expect(result.matched).toBe(false);
          }
        });
      }

      test('sec-topics has six single-chunk topics and no chunk matches any rule', () => {
        const topicDoc = documentNamed(topicPath);
        expect(topicDoc.chunks).toHaveLength(6);
        for (const chunk of topicDoc.chunks) {
          expect(scanText(chunk.text).rule_ids, chunk.section).toEqual([]);
          expect(chunk.text).not.toMatch(CANARY_RE);
        }
      });
    });
  }

  test('every canary appears exactly once across the attack fixtures', () => {
    const canaries = loadedCorpus.documents
      .filter((document) => /^sec-attacks\.[a-z]{2}\.md$/.test(path.posix.basename(document.relpath)))
      .flatMap((document) => document.content.match(CANARY_RE) ?? []);
    expect(canaries.length).toBe(Object.values(ATTACKS).flat().length);
    expect(new Set(canaries).size).toBe(canaries.length);
  });

  test('golden injection items point at rule-caught chunks and evasive items at chunks no rule catches (05.1-17)', () => {
    const items = readFileSync(GOLDEN_PATH, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as GoldenAttackLine)
      .filter((item) => item.category === 'injection' || item.category === 'injection_evasive');
    expect(items.length).toBeGreaterThanOrEqual(18);
    for (const item of items) {
      for (const span of item.attack?.injected_quotes ?? []) {
        const chunk = documentNamed(`${item.language}/${span.document}`).chunks.find((entry) => entry.section === span.section);
        expect(chunk?.text, item.id).toContain(span.quote);
        expect(chunk?.text, item.id).toContain(item.attack?.canary);
        expect(scanText(chunk?.text ?? '').matched, item.id).toBe(item.category === 'injection');
      }
    }
  });
});
