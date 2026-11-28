import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

const ORDER = [
  'RAG_RETRIEVAL_LOG',
  'RAG_RETRIEVAL_LOG_RETENTION_DAYS',
  'RAG_REFUSAL_FEEDBACK',
  'RAG_SOURCE_OPEN_SIGNAL',
  'RAG_EMBED_FEEDBACK',
  'RAG_EMBED_FEEDBACK_SECRET',
  'RAG_DOMAIN_EXPERT_REVIEW',
];
const TOGGLES = ['RAG_REFUSAL_FEEDBACK', 'RAG_SOURCE_OPEN_SIGNAL', 'RAG_EMBED_FEEDBACK', 'RAG_DOMAIN_EXPERT_REVIEW'];

function card(): string {
  const start = html.indexOf('id="rag-feedback-loop-settings"');
  expect(start, 'feedback loop card exists').toBeGreaterThan(-1);
  const end = html.indexOf('<!-- Prompt-injection defense -->', start);
  expect(end, 'card sits before the prompt-injection card').toBeGreaterThan(start);
  return html.slice(start, end);
}

function tagOf(markup: string, name: string): string {
  const match = markup.match(new RegExp(`<(input|select)\\b[^>]*\\bid="${name}"[^>]*>`));
  expect(match, `${name} control`).not.toBeNull();
  return match![0];
}

describe('Config UI: retrieval log and feedback card (UI-SPEC 6.2)', () => {
  it('sits after "Citations and groundedness" and before "Prompt-injection defense"', () => {
    const citations = html.indexOf('<!-- Citations and groundedness -->');
    const feedback = html.indexOf('id="rag-feedback-loop-settings"');
    const injection = html.indexOf('<!-- Prompt-injection defense -->');
    expect(citations).toBeGreaterThan(-1);
    expect(feedback).toBeGreaterThan(citations);
    expect(injection).toBeGreaterThan(feedback);
    expect(card()).toContain('Retrieval log and feedback');
  });

  it('lists the seven controls in the specified order, each with id and name equal to the env name', () => {
    const markup = card();
    const positions = ORDER.map((name) => markup.indexOf(`id="${name}"`));
    for (const [index, position] of positions.entries()) expect(position, ORDER[index]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const name of ORDER) expect(tagOf(markup, name)).toContain(`name="${name}"`);
  });

  it('renders the log level as a select with off, ids and masked_query', () => {
    const markup = card();
    const select = markup.slice(markup.indexOf('<select'), markup.indexOf('</select>'));
    expect(tagOf(markup, 'RAG_RETRIEVAL_LOG').startsWith('<select')).toBe(true);
    expect([...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])).toEqual(['off', 'ids', 'masked_query']);
  });

  it('renders retention as a number input bounded 1..365', () => {
    const tag = tagOf(card(), 'RAG_RETRIEVAL_LOG_RETENTION_DAYS');
    for (const attr of ['type="number"', 'min="1"', 'max="365"', 'step="1"', 'placeholder="30"', 'inputmode="numeric"', 'autocomplete="off"']) {
      expect(tag).toContain(attr);
    }
  });

  it('renders the four booleans as toggles', () => {
    for (const name of TOGGLES) {
      const tag = tagOf(card(), name);
      expect(tag).toContain('type="checkbox"');
      expect(tag).toMatch(/class="toggle toggle-primary"/);
    }
  });

  it('renders the secret as a password input with no value, autocomplete off and a show or hide button', () => {
    const markup = card();
    const tag = tagOf(markup, 'RAG_EMBED_FEEDBACK_SECRET');
    expect(tag).toContain('type="password"');
    expect(tag).toContain('autocomplete="off"');
    expect(tag).toContain('spellcheck="false"');
    expect(tag).toContain('placeholder="Empty until configured"');
    expect(tag).not.toMatch(/\bvalue=/);
    expect(markup).toMatch(/<button type="button" class="btn btn-square btn-outline" data-for="RAG_EMBED_FEEDBACK_SECRET" aria-label="Show or hide the embed feedback secret">/);
    expect(markup).toContain('<code translate="no">openssl rand -hex 32</code>');
  });

  it('ends every help line with the env name in code', () => {
    const markup = card();
    for (const name of ORDER) expect(markup, name).toContain(`<code translate="no">${name}</code>`);
  });
});
