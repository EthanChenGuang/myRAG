import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');
const region = html.match(/rag-ingestion-settings:start([\s\S]*?)rag-ingestion-settings:end/)?.[1] ?? '';

const SELECTS = [
  'RAG_PARSE_ROUTING',
  'RAG_PARSER_ALLOW_CLOUD',
  'RAG_PARSE_ESCALATION',
  'RAG_PARSE_VLM_DETECT',
  'RAG_INGEST_ASYNC',
  'RAG_INGEST_MAINTENANCE',
  'RAG_PARSE_PROGRESSIVE',
  'RAG_EMBED_BATCH_MODE',
  'NEXT_PUBLIC_RAG_INGEST_REALTIME',
];
const TEXT_INPUTS = ['RAG_PARSE_VLM_MODEL'];
const NUMBER_INPUTS = [
  'RAG_PARSE_PREMIUM_PAGE_BUDGET',
  'RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC',
  'RAG_INGEST_WORKER_CONCURRENCY',
  'RAG_INGEST_JOB_RETENTION_DAYS',
  'RAG_INGEST_MAINTENANCE_INTERVAL_SECONDS',
];
const HELP_TEXT = ['RAG_PARSE_ROUTING', 'RAG_PARSE_VLM_DETECT', 'RAG_PARSE_VLM_MODEL', 'RAG_INGEST_ASYNC'];

function openingTag(id: string): string {
  const matches = [...region.matchAll(new RegExp(`<(input|select)\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))];
  expect(matches, `exactly one control with id ${id} in the ingestion settings`).toHaveLength(1);
  return matches[0]![0];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

describe('Phase 3.1 ingestion switches in the Config UI (web-design-guidelines, plan 03.1-03 controls)', () => {
  it('every control has a name and a label tied to it with for', () => {
    for (const id of [...SELECTS, ...TEXT_INPUTS, ...NUMBER_INPUTS]) {
      expect(attr(openingTag(id), 'name'), id).toBe(id);
      expect(region, `label for ${id}`).toMatch(new RegExp(`<label\\b[^>]*\\bfor="${id}"`));
    }
  });

  it('no label in the region is left without a for or a wrapped control', () => {
    for (const label of region.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
      const tag = label[0].slice(0, label[0].indexOf('>') + 1);
      const isHelp = /class="label-text-alt"/.test(label[1]!);
      expect(isHelp || attr(tag, 'for') !== undefined || /<(input|select)\b/.test(label[1]!), tag).toBe(true);
    }
  });

  it('number and text fields opt out of autofill, number fields ask for a numeric keyboard', () => {
    for (const id of [...TEXT_INPUTS, ...NUMBER_INPUTS]) expect(attr(openingTag(id), 'autocomplete'), id).toBe('off');
    for (const id of NUMBER_INPUTS) expect(attr(openingTag(id), 'inputmode'), id).toBe('numeric');
    for (const id of TEXT_INPUTS) {
      expect(attr(openingTag(id), 'spellcheck'), id).toBe('false');
      expect(attr(openingTag(id), 'translate'), id).toBe('no');
    }
  });

  it('help text is tied to its control with aria-describedby', () => {
    for (const id of HELP_TEXT) {
      const describedBy = attr(openingTag(id), 'aria-describedby');
      expect(describedBy, id).toBe(`${id}_help`);
      expect(region).toContain(`id="${describedBy}"`);
    }
    const helpSpans = [...region.matchAll(/<span class="label-text-alt"([^>]*)>/g)];
    expect(helpSpans.length).toBe(HELP_TEXT.length);
    for (const span of helpSpans) expect(span[1], span[0]).toMatch(/\sid="[A-Z0-9_]+_help"/);
  });

  it('select values are code tokens that are not machine-translated', () => {
    for (const id of SELECTS) expect(attr(openingTag(id), 'translate'), id).toBe('no');
  });

  it('the group heading wraps evenly', () => {
    expect(region).toMatch(/<h4 class="[^"]*\btext-balance\b[^"]*">Ingestion<\/h4>/);
  });
});
