import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const META_RE = /^<!--\s*fixture-meta\s+(\{.*\})\s*-->\s*$/;

/**
 * A temporary copy of the fixture corpus without the files that generate duplicate-passage copies (04.2-37: thirty
 * near-identical documents per language from one template). For the rag-db tests that re-embed every current chunk into
 * a halfvec HNSW index (m = 64, ef_construction = 200): past 2m = 128 vectors every insert prunes full neighbour lists, which
 * costs about 0.5 s per 2048-dimension vector in PGlite's single-threaded WASM, so the 360 generated chunks alone made one
 * full re-embed take five minutes. Duplicate clustering has its own tests; these re-embed tests need distinct current chunks.
 */
export function corpusWithoutDuplicateCopies(options: { withoutLineages?: boolean } = {}): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-corpus-nodup-'));
  for (const language of fs.readdirSync(CORPUS_DIR)) {
    const source = path.join(CORPUS_DIR, language);
    if (!fs.statSync(source).isDirectory()) continue;
    fs.mkdirSync(path.join(out, language));
    for (const name of fs.readdirSync(source)) {
      const file = path.join(source, name);
      const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0]?.trim() ?? '';
      const meta = META_RE.exec(first);
      const fields = meta ? (JSON.parse(meta[1] as string) as Record<string, unknown>) : {};
      if ('generate' in fields) continue;
      // withoutLineages: also leave out the fixture-meta lineage versions (04.2-37 version notes), for tests of a database
      // in which no document has a version above 1.
      if (options.withoutLineages && 'lineage' in fields) continue;
      fs.copyFileSync(file, path.join(out, language, name));
    }
  }
  return out;
}
