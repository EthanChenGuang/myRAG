import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { chatRequest } from '../helpers/chat-route-fakes';
import { startRouteFixture, systemTextOf, type RouteFixture } from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  const session: { userId: string | null } = { userId: null };
  return {
    capture: fakes.createStreamTextCapture(),
    exa: fakes.createExaFake(),
    session,
    ssr: {
      auth: {
        getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }),
      },
    },
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const { userA, userB, orgO, docA, docB, docO } = TWO_TENANT_IDS;

const PHRASE_A = 'alpha personal notes';
const PHRASE_B = 'bravo personal notes';
const PHRASE_O = 'organization shared handbook';
const ALL_PHRASES_QUESTION = `Two tenant isolation canary phrase: ${PHRASE_A} ${PHRASE_B} ${PHRASE_O}`;

const OVERVIEW_TEXT = 'general information overview';
const OVERVIEW_MARKERS = { a: 'overviewmarkeralpha', b: 'overviewmarkerbravo', o: 'overviewmarkerorg' };

const OVERVIEW_DOCUMENTS = [
  { docId: '00000000-0000-4000-8000-0000000000f2', chunkId: '00000000-0000-4000-8000-0000000000f5', userId: userA, organizationId: null, filename: 'overview-a.md', marker: OVERVIEW_MARKERS.a },
  { docId: '00000000-0000-4000-8000-0000000000f3', chunkId: '00000000-0000-4000-8000-0000000000f6', userId: userB, organizationId: null, filename: 'overview-b.md', marker: OVERVIEW_MARKERS.b },
  { docId: '00000000-0000-4000-8000-0000000000f4', chunkId: '00000000-0000-4000-8000-0000000000f7', userId: userA, organizationId: orgO, filename: 'overview-o.md', marker: OVERVIEW_MARKERS.o },
];

async function seedOverviewDocuments(db: PGlite): Promise<void> {
  for (const doc of OVERVIEW_DOCUMENTS) {
    await db.query('INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)', [
      doc.docId,
      doc.filename,
      `${OVERVIEW_TEXT} ${doc.marker}`,
      JSON.stringify({ relpath: `two-tenant/${doc.filename}` }),
      doc.userId,
      doc.organizationId,
      '2025-01-16T00:00:00.000Z',
    ]);
    await db.query(
      'INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, organization_id, created_at) VALUES ($1, $2, $3, $4::vector, 0, $5::jsonb, $6, $7)',
      [
        doc.chunkId,
        doc.docId,
        `Document: ${doc.filename}. Chunk 1 of 1. Content: ${OVERVIEW_TEXT} ${doc.marker}`,
        `[${embedText(OVERVIEW_TEXT).join(',')}]`,
        JSON.stringify({ name: doc.filename }),
        doc.organizationId,
        '2025-01-16T00:00:00.000Z',
      ],
    );
  }
}

/** The route turns a text-plus-document array into a plain string unless an image part is present; an image part without a url keeps the array and skips image generation. */
const KEEP_ARRAY_PART = { type: 'image_url', image_url: {} };

function configuredModelId(): string {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  const id = models.map((model) => model.id).find((candidate) => !/gpt-4|o1|chatgpt/.test(candidate) && !candidate.includes('claude'));
  return id as string;
}

function readSseText(body: string): string {
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { type?: string; delta?: string };
      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') text += chunk.delta;
    } catch {
      continue;
    }
  }
  return text;
}

describe('chat route two-tenant isolation', () => {
  let fixture: RouteFixture;
  let warn: ReturnType<typeof vi.spyOn>;
  const model = configuredModelId();

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'multi-tenant', twoTenant: true, seed: seedOverviewDocuments });
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    h.session.userId = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  async function post(messages: Array<Record<string, unknown>>, options: { userId: string | null; organizationId?: string | null }) {
    h.session.userId = options.userId;
    const { POST } = await fixture.loadRoute('chat');
    return POST(
      chatRequest({
        messages,
        data: {
          ragMode: 'strict',
          organizationId: options.organizationId ?? null,
          settings: { webSearch: false, model },
        },
      }),
    );
  }

  function ask(question: string, options: { userId: string | null; organizationId?: string | null }) {
    return post([{ role: 'user', content: question }], options);
  }

  function capturedSystem(): string {
    expect(h.capture.calls, 'streamText should have been reached').toHaveLength(1);
    return systemTextOf(h.capture.calls[0]);
  }

  function tenantWarnings(): unknown[][] {
    return warn.mock.calls.filter((args: unknown[]) => String(args[0]).startsWith('[RAG Tenant]'));
  }

  it('(a) B posting organizationId O gets 403 JSON and the model is never called', async () => {
    const response = await ask(ALL_PHRASES_QUESTION, { userId: userB, organizationId: orgO });

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(h.capture.calls).toHaveLength(0);
    const text = await response.text();
    for (const phrase of [PHRASE_A, PHRASE_B, PHRASE_O]) expect(text).not.toContain(phrase);
  });

  it('(b) A without an organization sees A, never B or O', async () => {
    const response = await ask(ALL_PHRASES_QUESTION, { userId: userA, organizationId: null });
    await response.text();

    const system = capturedSystem();
    expect(system).toContain(PHRASE_A);
    expect(system).not.toContain(PHRASE_B);
    expect(system).not.toContain(PHRASE_O);
  });

  it('(c) A with organization O sees O only', async () => {
    const response = await ask(ALL_PHRASES_QUESTION, { userId: userA, organizationId: orgO });
    await response.text();

    const system = capturedSystem();
    expect(system).toContain(PHRASE_O);
    expect(system).not.toContain(PHRASE_A);
    expect(system).not.toContain(PHRASE_B);
  });

  it('(d) A mentioning her own filename reads it, A mentioning B filename reads nothing of B', async () => {
    const own = await ask('@tenant-a-personal.md what does it say?', { userId: userA });
    await own.text();
    const ownSystem = capturedSystem();
    expect(ownSystem).toContain('=== DOCUMENT: "tenant-a-personal.md" ===');
    expect(ownSystem).toContain(PHRASE_A);
    expect(ownSystem).not.toContain(PHRASE_B);

    h.capture.reset();
    const foreign = await ask(`@tenant-b-personal.md what does it say? ${PHRASE_B}`, { userId: userA });
    await foreign.text();
    const foreignText = h.capture.calls.length > 0 ? systemTextOf(h.capture.calls[0]) : readSseText(await foreign.clone().text());
    expect(foreignText).not.toContain(PHRASE_B);
    expect(foreignText).not.toContain('tenant-b-personal.md');
    expect(foreignText).not.toContain('=== DOCUMENT:');
  });

  it('(e) a document part with B document id reads nothing of B and logs one RAG Tenant warning', async () => {
    const foreign = await post(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: `summarize ${PHRASE_A}` },
            KEEP_ARRAY_PART,
            { type: 'document', document: { id: docB, name: 'tenant-b-personal.md' } },
          ],
        },
      ],
      { userId: userA },
    );
    await foreign.text();

    const system = capturedSystem();
    expect(system).not.toContain(PHRASE_B);
    expect(system).not.toContain('tenant-b-personal.md');
    expect(system).not.toContain('=== DOCUMENT:');
    const warnings = tenantWarnings().filter((args) => JSON.stringify(args[1]) === JSON.stringify({ ignoredReferences: 1 }));
    expect(warnings).toHaveLength(1);

    h.capture.reset();
    warn.mockClear();
    const own = await post(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarize this document' },
            KEEP_ARRAY_PART,
            { type: 'document', document: { id: docA, name: 'tenant-a-personal.md' } },
          ],
        },
      ],
      { userId: userA },
    );
    await own.text();
    const ownSystem = capturedSystem();
    expect(ownSystem).toContain('=== DOCUMENT: "tenant-a-personal.md" ===');
    expect(ownSystem).toContain(PHRASE_A);
    expect(tenantWarnings()).toHaveLength(0);
  });

  it('(e2) an organization document id is ignored outside the organization scope and read inside it', async () => {
    const personal = await post(
      [{ role: 'user', content: [{ type: 'text', text: 'summarize' }, KEEP_ARRAY_PART, { type: 'document', document: { id: docO, name: 'tenant-o-organization.md' } }] }],
      { userId: userA, organizationId: null },
    );
    const personalBody = await personal.text();
    const personalSeen = h.capture.calls.length > 0 ? systemTextOf(h.capture.calls[0]) : readSseText(personalBody);
    expect(personalSeen).not.toContain(PHRASE_O);
    expect(personalSeen).not.toContain('=== DOCUMENT:');

    h.capture.reset();
    const inOrg = await post(
      [{ role: 'user', content: [{ type: 'text', text: 'summarize' }, KEEP_ARRAY_PART, { type: 'document', document: { id: docO, name: 'tenant-o-organization.md' } }] }],
      { userId: userA, organizationId: orgO },
    );
    await inOrg.text();
    expect(capturedSystem()).toContain(PHRASE_O);
  });

  it('(f) no session gets the strict refusal and no vector search is issued', async () => {
    const before = fixture.edge.calls.length;
    const response = await ask(ALL_PHRASES_QUESTION, { userId: null });
    const body = await response.text();

    expect(h.capture.calls).toHaveLength(0);
    expect(readSseText(body)).toContain('Information Not Available');
    const rpcCalls = fixture.edge.calls.slice(before).filter((call) => call.path.includes('/rpc/'));
    expect(rpcCalls).toEqual([]);
    for (const phrase of [PHRASE_A, PHRASE_B, PHRASE_O]) expect(body).not.toContain(phrase);
  });

  it('(g) a message with no text takes the overview path and shows only the caller documents', async () => {
    const personal = await ask('', { userId: userA, organizationId: null });
    await personal.text();
    const personalSystem = capturedSystem();
    expect(personalSystem).toContain(OVERVIEW_MARKERS.a);
    expect(personalSystem).not.toContain(OVERVIEW_MARKERS.b);
    expect(personalSystem).not.toContain(OVERVIEW_MARKERS.o);

    h.capture.reset();
    const asB = await ask('', { userId: userB, organizationId: null });
    await asB.text();
    const bSystem = capturedSystem();
    expect(bSystem).toContain(OVERVIEW_MARKERS.b);
    expect(bSystem).not.toContain(OVERVIEW_MARKERS.a);
    expect(bSystem).not.toContain(OVERVIEW_MARKERS.o);

    h.capture.reset();
    const inOrg = await ask('', { userId: userA, organizationId: orgO });
    await inOrg.text();
    const orgSystem = capturedSystem();
    expect(orgSystem).toContain(OVERVIEW_MARKERS.o);
    expect(orgSystem).not.toContain(OVERVIEW_MARKERS.a);
    expect(orgSystem).not.toContain(OVERVIEW_MARKERS.b);
  });

  it('(g2) the overview fallback with no session never reads any tenant', async () => {
    const before = fixture.edge.calls.length;
    const response = await ask('', { userId: null });
    const body = await response.text();

    expect(h.capture.calls).toHaveLength(0);
    for (const marker of Object.values(OVERVIEW_MARKERS)) expect(body).not.toContain(marker);
    expect(fixture.edge.calls.slice(before).filter((call) => call.path.includes('/rpc/'))).toEqual([]);
  });

  it('never needed an unsupported edge request for the lookups it relies on', () => {
    const lookups = fixture.edge.errors.filter((error) => error.url.includes('/rest/v1/documents') && error.url.includes('filename='));
    expect(lookups).toEqual([]);
  });
});
