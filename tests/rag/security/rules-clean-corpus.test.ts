import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { scanText } from '@/lib/rag/security/injection-rules';
import { resetInjectionRulesForTests, setInjectionRulesForTests } from '@/lib/rag/security/injection-scan';
import { loadCorpus, type CorpusDocument } from '../../../eval/harness/corpus.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const ATTACK_FIXTURE = /^sec-attacks\.[a-z]{2}\.md$/;

interface Finding {
  document: string;
  chunk: number;
  ruleIds: string[];
}

afterEach(() => {
  resetInjectionRulesForTests();
});

/** Document names a golden item declares as injected (attack.injected_quotes[].document); items without attack add none. */
function injectedDocuments(goldenText: string): Set<string> {
  const names = new Set<string>();
  for (const line of goldenText.split('\n')) {
    if (line.trim() === '') continue;
    const item = JSON.parse(line) as { attack?: { injected_quotes?: Array<{ document?: unknown }> } | null };
    for (const quote of item.attack?.injected_quotes ?? []) {
      if (typeof quote.document === 'string') names.add(quote.document);
    }
  }
  return names;
}

function isExcluded(document: CorpusDocument, injected: Set<string>): boolean {
  const basename = path.posix.basename(document.relpath);
  return ATTACK_FIXTURE.test(basename) || injected.has(basename) || injected.has(document.filename);
}

function scanDocuments(documents: CorpusDocument[]): Finding[] {
  const findings: Finding[] = [];
  for (const document of documents) {
    for (const chunk of document.chunks) {
      const result = scanText(chunk.text);
      if (result.matched) findings.push({ document: document.relpath, chunk: chunk.index, ruleIds: result.rule_ids });
    }
  }
  return findings;
}

/** Names the document, chunk ordinal and rule ids; never the chunk text or snippets. */
function describeFindings(findings: Finding[]): string {
  return findings.map((finding) => `${finding.document} chunk ${finding.chunk}: ${finding.ruleIds.join(', ')}`).join('\n');
}

function cleanCorpus(): CorpusDocument[] {
  const injected = injectedDocuments(readFileSync(GOLDEN_PATH, 'utf8'));
  return loadCorpus(CORPUS_DIR).documents.filter((document) => !isExcluded(document, injected));
}

describe('injection rules on the clean fixture corpus (D-14)', () => {
  test('every chunk of every clean corpus document produces zero rule matches', () => {
    const documents = cleanCorpus();
    expect(documents.length, 'clean corpus documents scanned').toBeGreaterThanOrEqual(10);
    const findings = scanDocuments(documents);
    expect(findings, describeFindings(findings)).toEqual([]);
  });

  test('only attack fixtures and golden-declared injected documents are excluded', () => {
    const golden = [
      JSON.stringify({ id: 'x-1', attack: { injected_quotes: [{ document: 'refund-policy.en.md', quote: 'q' }] } }),
      JSON.stringify({ id: 'x-2' }),
      '',
    ].join('\n');
    const injected = injectedDocuments(golden);
    const all = loadCorpus(CORPUS_DIR).documents;
    const excluded = all.filter((document) => isExcluded(document, injected)).map((document) => document.relpath);
    expect(excluded).toEqual(['en/refund-policy.en.md']);
    const named = (relpath: string) => ({ ...all[0], relpath, filename: path.posix.basename(relpath) }) as CorpusDocument;
    expect(isExcluded(named('en/sec-attacks.en.md'), new Set())).toBe(true);
    expect(isExcluded(named('en/sec-attacks-notes.en.md'), new Set())).toBe(false);
  });

  test('the gate is not vacuous: a rule that hits corpus text is reported by document, chunk and rule id without text', () => {
    setInjectionRulesForTests({
      schema_version: 1,
      rules: [{ id: 'inj-en-98', language: 'en', kind: 'regex', severity: 'low', pattern: '\\brefund\\b' }],
    });
    const documents = cleanCorpus();
    const findings = scanDocuments(documents);
    expect(findings.length).toBeGreaterThan(0);
    const message = describeFindings(findings);
    expect(message).toMatch(/^en\/refund-policy\.en\.md chunk \d+: inj-en-98$/m);
    for (const finding of findings) {
      const document = documents.find((entry) => entry.relpath === finding.document) as CorpusDocument;
      const text = document.chunks[finding.chunk]?.text as string;
      expect(message).not.toContain(text.slice(0, 40));
    }
  });
});
