// Plan 05-26 Task 1, research A1 on the AI SDK path: Claude citations + a client webSearch tool + two steps.
// Synthetic text only; the tool returns a fixed synthetic result and contacts nothing. Never prints a key.
import { writeFileSync } from 'node:fs';
import { streamText, tool, stepCountIs, type ToolSet } from 'ai';
import { z } from 'zod';
import { createClaudeProvider, buildClaudeCitationRequest } from '@/lib/rag/generation/citations/claude';
import { claudeMarkerTransform } from '@/lib/rag/generation/citations/claude-transform';
import { buildAliasMap, createCitationLabeler } from '@/lib/rag/generation/citations/blocks';
import type { ContextBlock } from '@/lib/rag/types';

const OUT = 'eval/out/05-26-t1';
const key = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
if (!key) { console.log('skipped: no key'); process.exit(0); }
const labeler = createCitationLabeler();
const raw = { title: 'Harbor notes', text: 'The Velmora lighthouse was painted green in 1931. Its lamp was replaced with an electric one in 1952.' };
const base = { documentId: '00000000-0000-4000-8000-000000000001', documentName: 'Harbor notes.txt', documentVersion: 1,
  chunkIds: ['00000000-0000-4000-9000-000000000001'], page: null, sectionPath: null, title: raw.title, text: raw.text, isImage: false };
const label = labeler(base, 1);
const aliasMap = buildAliasMap([{ ...base, text: label.text, alias: label.alias } as ContextBlock]);

const sse: string[] = [];
const urls: string[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  urls.push(String(input instanceof Request ? input.url : input));
  const res = await fetch(input, init);
  const [a, b] = res.body ? res.body.tee() : [null, null];
  if (b) new Response(b).text().then((t) => sse.push(t));
  return new Response(a, { status: res.status, headers: res.headers });
};
const provider = createClaudeProvider({ apiKey: key, baseUrl: 'https://api.anthropic.com/v1', fetch: recordingFetch });
const tools: ToolSet = {
  webSearch: tool({
    description: 'Search the web for current information.',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => ({ results: [{ title: 'Synthetic result', url: 'https://example.invalid/lamp', text: 'A synthetic page says the first electric lighthouse lamp was tested in 1858.' }] }),
  }),
};
const cites: unknown[] = [];
const invalid: unknown[] = [];
const req = buildClaudeCitationRequest({ provider, aliasMap, system: 'Answer from the attached documents and cite them. Use webSearch for anything the documents do not cover.',
  history: [], anthropicId: 'claude-haiku-5-5',
  question: 'From the document: what colour was the Velmora lighthouse painted? Then use webSearch to find the year the first electric lighthouse lamp was tested, and answer both.' });
const t0 = Date.now();
const result = streamText({ ...req, maxOutputTokens: 512, tools, stopWhen: stepCountIs(2),
  experimental_transform: [claudeMarkerTransform(aliasMap, { cite: (c) => cites.push(c), invalid: (f) => invalid.push(f) })] });
const parts: Record<string, number> = {};
let text = '';
let error: string | null = null;
for await (const p of result.fullStream) {
  parts[p.type] = (parts[p.type] ?? 0) + 1;
  if (p.type === 'text-delta') text += p.text;
  if (p.type === 'error') error = String((p.error as Error)?.message ?? p.error).slice(0, 300);
}
await new Promise((r) => setTimeout(r, 200));
writeFileSync(`${OUT}/a1-sdk-raw.sse`, sse.join('\n\n===== next request =====\n\n'));
const report = { requests: urls.length, urls, totalMs: Date.now() - t0, steps: (await result.steps).length, parts,
  citations: cites.map((c) => ({ alias: (c as { alias: string }).alias, citedText: (c as { citedText: string }).citedText })),
  invalidSources: invalid.length, error, text };
writeFileSync(`${OUT}/report-a1-sdk.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
