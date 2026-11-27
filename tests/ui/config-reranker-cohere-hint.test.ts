import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');
const initEnv = fs.readFileSync('scripts/init-env.js', 'utf8');

describe('RAG_RERANKER=auto discloses the Cohere data flow (04.1 verification G-11)', () => {
  it('describes the reranker select with a hint naming Cohere', () => {
    expect(html).toMatch(/<select id="RAG_RERANKER"[^>]*aria-describedby="rag-reranker-help"/);
    const hint = html.match(/<p[^>]*id="rag-reranker-help"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
    expect(hint).toContain('COHERE_API_KEY');
    expect(hint).toMatch(/sent to <span translate="no">Cohere<\/span>/);
  });

  it('says so in the init-env template next to RAG_RERANKER', () => {
    const block = initEnv.slice(initEnv.indexOf('# Reranker: none | auto'), initEnv.indexOf('RAG_RERANKER=none'));
    expect(block).toMatch(/query and candidate text are sent to Cohere/);
  });
});
