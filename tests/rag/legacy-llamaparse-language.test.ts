import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-4000-8000-0000000000b1';
const BODY = '%PDF-1.4 placeholder body';
const LANGUAGE_VARS = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;

type Field = [name: string, value: string];

const state = {
  session: null as { id: string } | null,
  uploads: [] as Field[][],
  calls: 0,
};

/** The form fields of a form-data body in order; a file part is recorded as `<file>`. */
function fieldsOf(body: unknown): Field[] {
  const streams = (body as { _streams?: unknown[] })._streams ?? [];
  const fields: Field[] = [];
  for (let index = 0; index < streams.length; index += 1) {
    const part = streams[index];
    if (typeof part !== 'string') continue;
    const match = /name="([^"]+)"/.exec(part);
    if (!match) continue;
    const value = streams[index + 1];
    fields.push([match[1], /filename="/.test(part) ? '<file>' : String(value)]);
    index += 1;
  }
  return fields;
}

function fakeLlamaFetch() {
  return async (url: string, init?: { body?: unknown }) => {
    state.calls += 1;
    const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' });
    if (String(url).endsWith('/parsing/upload')) {
      state.uploads.push(fieldsOf(init?.body));
      return { ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}), text: async () => 'stop after the upload' };
    }
    return json({ status: 'SUCCESS' });
  };
}

function routeAdmin() {
  return {
    from() {
      const builder: Record<string, unknown> = {
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: () => builder,
        select: () => builder,
        single: () => Promise.resolve({ data: { id: 'doc' }, error: null }),
        then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok, bad),
      };
      return builder;
    },
    storage: { from: () => ({ upload: async () => ({ data: {}, error: null }), getPublicUrl: () => ({ data: { publicUrl: 'http://127.0.0.1/x' } }) }) },
  };
}

function stubLanguages(supported: string, primary: string): void {
  vi.stubEnv('RAG_SUPPORTED_LANGUAGES', supported);
  vi.stubEnv('RAG_PRIMARY_LANGUAGE', primary);
}

const LLAMACLOUD_VARS = [
  'LLAMACLOUD_PARSING_MODE', 'LLAMACLOUD_CHUNK_STRATEGY', 'LLAMACLOUD_CHUNK_SIZE', 'LLAMACLOUD_CHUNK_OVERLAP', 'LLAMACLOUD_PARSE_MODE',
  'LLAMACLOUD_PARSE_MODEL', 'LLAMACLOUD_HIGH_RES_OCR', 'LLAMACLOUD_ADAPTIVE_LONG_TABLE', 'LLAMACLOUD_OUTLINED_TABLE_EXTRACTION',
  'LLAMACLOUD_OUTPUT_TABLES_AS_HTML', 'LLAMACLOUD_MULTIMODAL_PARSING',
];

function commonMocks(): void {
  for (const name of LLAMACLOUD_VARS) vi.stubEnv(name, '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key-placeholder');
  vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
  vi.stubEnv('RAG_INGEST_PIPELINE', 'legacy');
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => 'multi-tenant',
    isMultiTenant: () => true,
    isSingleTenant: () => false,
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => routeAdmin(),
    getSupabase: () => ({}),
    storeDocument: async () => 'doc',
  }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ verifyUserOrganizationAccess: async () => ({ hasAccess: false }) }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => routeAdmin() }));
  vi.doMock('node-fetch', () => ({ default: fakeLlamaFetch() }));
}

async function routeUpload(options: { temporary?: boolean } = {}): Promise<Field[]> {
  vi.resetModules();
  commonMocks();
  state.session = { id: USER };
  const { POST } = await import('@/app/api/process-document/route');
  const form = new FormData();
  form.append('file', new File([BODY], 'report.pdf', { type: 'application/pdf' }));
  form.append('isTemporary', String(options.temporary ?? false));
  await POST(new Request('http://localhost/api/process-document', { method: 'POST', body: form }));
  expect(state.uploads).toHaveLength(1);
  return state.uploads[0];
}

async function processorUpload(): Promise<Field[]> {
  vi.resetModules();
  commonMocks();
  const { processDocument } = await import('@/lib/document-processor');
  await expect(processDocument('report.pdf', Buffer.from(BODY), { user_id: USER })).rejects.toThrow(/Upload failed/);
  expect(state.uploads).toHaveLength(1);
  return state.uploads[0];
}

// Recorded from both call sites before plan 03.2-24 (languages unset, every LLAMACLOUD_* variable at its env.ts default).
const RECORDED_ROUTE: Field[] = [
  ['file', '<file>'],
  ['parsing_config', '{"chunk_size":768,"chunk_overlap":416,"chunk_strategy":"sentence","include_chunks":true,"include_metadata":true,"include_images":true}'],
  ['output_config', '{"result_type":"markdown","language":"en"}'],
  ['auto_mode', 'true'],
  ['auto_mode_trigger_on_table', 'true'],
  ['auto_mode_trigger_on_image', 'true'],
];

const RECORDED_PROCESSOR: Field[] = [
  ['file', '<file>'],
  ['parse_mode', 'parse_page_with_agent'],
  ['model', 'openai-gpt-4-1-mini'],
  ['high_res_ocr', 'true'],
  ['adaptive_long_table', 'true'],
  ['outlined_table_extraction', 'true'],
  ['output_tables_as_HTML', 'true'],
  ['parsing_config', '{"chunk_size":768,"chunk_overlap":416,"chunk_strategy":"sentence","include_chunks":true,"include_metadata":true,"include_images":true}'],
  ['output_config', '{"result_type":"markdown","language":"en"}'],
];

function withLanguage(recorded: Field[], codes: string): Field[] {
  const out: Field[] = [];
  for (const [name, value] of recorded) {
    if (name === 'output_config') {
      out.push([name, '{"result_type":"markdown"}']);
      out.push(['language', codes]);
    } else {
      out.push([name, value]);
    }
  }
  return out;
}

beforeEach(() => {
  state.session = null;
  state.uploads = [];
  state.calls = 0;
  for (const name of LANGUAGE_VARS) vi.stubEnv(name, '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const id of ['@/lib/deployment-mode', '@/lib/supabase/server', '@/lib/supabase', '@/lib/auth/organization-handler', '@supabase/supabase-js', 'node-fetch']) {
    vi.doUnmock(id);
  }
});

describe('legacy LlamaParse request: languages unset (D-16)', () => {
  it('process-document route: the knowledge-base upload body equals the recorded one, field for field', async () => {
    expect(await routeUpload()).toEqual(RECORDED_ROUTE);
  });

  it('process-document route: a temporary attachment body equals the recorded one', async () => {
    expect(await routeUpload({ temporary: true })).toEqual(RECORDED_ROUTE);
  });

  it('document-processor: the body equals the recorded one, field for field', async () => {
    expect(await processorUpload()).toEqual(RECORDED_PROCESSOR);
  });

  it('never reads the language settings while both variables are unset', async () => {
    vi.resetModules();
    const settings = await import('@/lib/rag/lang/settings');
    let trapped = 0;
    settings.setLanguageSettingsTrapForTests(() => {
      trapped += 1;
      throw new Error('[Legacy LlamaParse Test] the language settings were read');
    });
    try {
      commonMocks();
      state.session = { id: USER };
      const { processDocument } = await import('@/lib/document-processor');
      await expect(processDocument('report.pdf', Buffer.from(BODY), { user_id: USER })).rejects.toThrow(/Upload failed/);
      expect(state.uploads[0]).toEqual(RECORDED_PROCESSOR);
      expect(trapped).toBe(0);
    } finally {
      settings.setLanguageSettingsTrapForTests(null);
    }
  });
});

describe('legacy LlamaParse request: languages configured (D-16, research F-3)', () => {
  it('process-document route: top-level language field with registry codes, primary first; output_config holds only result_type', async () => {
    stubLanguages('zh,it', 'it');
    const fields = await routeUpload();
    expect(fields).toEqual(withLanguage(RECORDED_ROUTE, 'it,ch_sim'));
    const output = fields.find(([name]) => name === 'output_config');
    expect(JSON.parse(output![1])).toEqual({ result_type: 'markdown' });
  });

  it('process-document route: a temporary attachment carries the same field', async () => {
    stubLanguages('zh,it', 'it');
    expect(await routeUpload({ temporary: true })).toEqual(withLanguage(RECORDED_ROUTE, 'it,ch_sim'));
  });

  it('document-processor: top-level language field with registry codes, primary first', async () => {
    stubLanguages('zh,it', 'it');
    expect(await processorUpload()).toEqual(withLanguage(RECORDED_PROCESSOR, 'it,ch_sim'));
  });

  it('one configured language gives one code', async () => {
    stubLanguages('zh', 'zh');
    expect(await processorUpload()).toEqual(withLanguage(RECORDED_PROCESSOR, 'ch_sim'));
    state.uploads = [];
    expect(await routeUpload()).toEqual(withLanguage(RECORDED_ROUTE, 'ch_sim'));
  });

  it('the same languages under RAG_INGEST_PIPELINE=legacy with the primary in the middle keep the primary first', async () => {
    stubLanguages('zh,en,it', 'en');
    expect(await processorUpload()).toEqual(withLanguage(RECORDED_PROCESSOR, 'en,ch_sim,it'));
  });

  it('RAG_PARSER_ALLOW_CLOUD=false still sends nothing at either call site', async () => {
    stubLanguages('zh,it', 'it');
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'false');
    vi.resetModules();
    commonMocks();
    state.session = { id: USER };
    const { POST } = await import('@/app/api/process-document/route');
    const form = new FormData();
    form.append('file', new File([BODY], 'report.pdf', { type: 'application/pdf' }));
    form.append('isTemporary', 'false');
    const response = await POST(new Request('http://localhost/api/process-document', { method: 'POST', body: form }));
    expect(response.status).toBe(503);
    const { processDocument } = await import('@/lib/document-processor');
    await expect(processDocument('report.pdf', Buffer.from(BODY), { user_id: USER })).rejects.toThrow(/cloud_parsing_disabled/);
    expect(state.calls).toBe(0);
  });
});
