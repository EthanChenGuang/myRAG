import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../eval/fixtures/corpus');
const DUPLICATE_TEMPLATE = /^dup-passage\.template\./;

/**
 * A temporary copy of the fixture corpus without the 04.2-37 duplicate-passage templates, whose 90 generated copies are most of
 * the corpus chunks. For suites that write or scan every chunk and test nothing about duplicates; every other document is kept.
 * The caller removes the directory with removeCompactCorpus.
 */
export function compactFixtureCorpus(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-corpus-'));
  fs.cpSync(FIXTURE_CORPUS, target, { recursive: true, filter: (file) => !DUPLICATE_TEMPLATE.test(path.basename(file)) });
  return target;
}

export function removeCompactCorpus(dir: string | undefined): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
