import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkParentChild, type ParentChildProfile } from '@/lib/rag/ingest/chunkers/parent-child';
import { loadIngestConfig, resetIngestConfigForTests, type IngestConfig } from '@/lib/rag/ingest/config';
import { normalizeWithOutline, resetSectionOutlinesForTests, sectionOutlineInputFor } from '@/lib/rag/ingest/outline';
import { buildProfileChunks, type ChunkingProfileRow, type ProfileDocument } from '@/lib/rag/ingest/profile-chunks';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { chunkStage } from '@/lib/rag/ingest/stages/chunk';
import { ingestStateFromRecord } from '@/lib/rag/ingest/status';
import { emptyIngestState, type StageContext } from '@/lib/rag/ingest/types';
import { ALPHA_LABEL, BETA_LABEL, DOCUMENT, OUTLINE, SECTION_PATHS, outlineFile, writeOutlineFile } from './section-outline-fixture';

const GENERAL = getProcessingProfile('general');

function stageContext(config: IngestConfig | undefined, tenantKey = 's:default'): StageContext {
  const ctx = {
    identity: {
      tenantKey,
      filename: 'sheet.md',
      fileSha256: 'x',
      docType: 'general',
      docTypeOrigin: 'picked',
      profile: GENERAL,
      bytes: null,
    },
    warnings: [],
    state: emptyIngestState(),
    work: { parseText: DOCUMENT, parserVersion: null, chunks: [], chunksWritten: 0 },
  } as unknown as StageContext;
  if (config) (ctx as { config: IngestConfig }).config = config;
  return ctx;
}

const PROFILE: ChunkingProfileRow = { id: 'p-structure', docType: 'general', childTokens: 256, parentMode: 'structure', parentTokens: 1024, status: 'active' };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetSectionOutlinesForTests();
  resetIngestConfigForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('RAG_SECTION_OUTLINES config', () => {
  it('defaults to an empty path and warns nothing', () => {
    expect(loadIngestConfig({}).sectionOutlinesPath).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('trims the value and keeps it with the legacy pipeline', () => {
    expect(loadIngestConfig({ RAG_SECTION_OUTLINES: '  /srv/outlines.json  ' }).sectionOutlinesPath).toBe('/srv/outlines.json');
    const legacy = loadIngestConfig({ RAG_INGEST_PIPELINE: 'legacy', RAG_SECTION_OUTLINES: 'outlines.json' });
    expect(legacy.pipeline).toBe('legacy');
    expect(legacy.sectionOutlinesPath).toBe('outlines.json');
    expect(legacy.warnings).toEqual([]);
  });
});

describe('chunk stage', () => {
  it('chunks as today with the variable unset', async () => {
    const plain = stageContext(undefined);
    const off = stageContext(loadIngestConfig({}));
    expect(await chunkStage.run(plain)).toEqual({ kind: 'next' });
    expect(await chunkStage.run(off)).toEqual({ kind: 'next' });
    expect(off.work.chunks).toEqual(plain.work.chunks);
    expect(off.work.chunks.every((chunk) => !('section_outline' in chunk.metadata))).toBe(true);
    expect('sectionOutline' in off.state).toBe(false);
  });

  it('cuts by the outline for an allowed tenant and records it in the state', async () => {
    const filePath = writeOutlineFile(outlineFile([{ ...OUTLINE, tenant_keys: ['s:default'] }]));
    const ctx = stageContext(loadIngestConfig({ RAG_SECTION_OUTLINES: filePath }));
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'next' });
    expect(ctx.work.chunks.every((chunk) => chunk.metadata.section_outline === 'neutral-sheet@1')).toBe(true);
    expect(ctx.work.chunks.map((chunk) => chunk.section_path)).toEqual([[], ...SECTION_PATHS(ALPHA_LABEL), ...SECTION_PATHS(BETA_LABEL)]);
    expect(ctx.work.chunks[1]?.metadata).toMatchObject({ document_title: 'sheet.md', chunk_index: 1, section_outline: 'neutral-sheet@1' });
    expect(ctx.state.sectionOutline).toEqual({ outlineId: 'neutral-sheet', version: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('chunks as today for a tenant the outline does not list, and clears a stale state key', async () => {
    const filePath = writeOutlineFile(outlineFile([{ ...OUTLINE, tenant_keys: ['s:another'] }]));
    const plain = stageContext(undefined);
    await chunkStage.run(plain);
    const ctx = stageContext(loadIngestConfig({ RAG_SECTION_OUTLINES: filePath }));
    ctx.state.sectionOutline = { outlineId: 'neutral-sheet', version: 1 };
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'next' });
    expect(ctx.work.chunks).toEqual(plain.work.chunks);
    expect('sectionOutline' in ctx.state).toBe(false);
  });
});

describe('chunkParentChild', () => {
  const modes: ParentChildProfile[] = [
    { childTokens: 256, parentMode: 'none', parentTokens: null },
    { childTokens: 256, parentMode: 'structure', parentTokens: 1024 },
    { childTokens: 128, parentMode: 'fixed', parentTokens: 512 },
  ];

  for (const profile of modes) {
    it(`gives today's cut without an outline in ${profile.parentMode} mode`, () => {
      const plain = chunkParentChild(DOCUMENT, profile, GENERAL.chunker);
      expect(chunkParentChild(DOCUMENT, profile, GENERAL.chunker, undefined, {}, null)).toEqual(plain);
      expect('sectionOutline' in plain).toBe(false);
    });
  }

  it('makes each outline section one structure parent', () => {
    const filePath = writeOutlineFile(outlineFile());
    const sectionOutline = sectionOutlineInputFor(filePath, 's:default');
    const result = chunkParentChild(DOCUMENT, modes[1]!, GENERAL.chunker, undefined, {}, sectionOutline);
    const paths = [[], ...SECTION_PATHS(ALPHA_LABEL), ...SECTION_PATHS(BETA_LABEL)];
    expect(result.parents.map((parent) => parent.section_path)).toEqual(paths);
    const scope = result.parents.find((parent) => parent.section_path.join('/') === `${BETA_LABEL}/2 Scope`);
    expect(scope?.content).toBe('The scope of the beta widget covers bench tests and shelf storage in a plain sample room for its parts.');
    const details = result.parents.find((parent) => parent.section_path.join('/') === `${ALPHA_LABEL}/2 Scope/2.1 Details`);
    expect(details?.content).toBe('The details of the alpha widget list its size, its weight and its colour, see section 3 Notes for more of it.');
    for (const child of result.children) expect(child.section_path).toEqual(result.parents[child.parent_index ?? -1]?.section_path);
    expect(result.sectionOutline).toEqual(normalizeWithOutline(DOCUMENT, sectionOutline).report);
  });
});

describe('buildProfileChunks', () => {
  const document: ProfileDocument = { filename: 'sheet.md', chunker: GENERAL.chunker, templateHeader: 'Sheet' };

  it('builds as today without an outline', () => {
    const plain = buildProfileChunks(document, DOCUMENT, PROFILE);
    expect(buildProfileChunks({ ...document, sectionOutline: null }, DOCUMENT, PROFILE)).toEqual(plain);
    expect(plain.children.every((child) => !('section_outline' in child.metadata))).toBe(true);
    expect('sectionOutline' in plain).toBe(false);
  });

  it('stamps every child and carries the report with an outline', () => {
    const sectionOutline = sectionOutlineInputFor(writeOutlineFile(outlineFile()), 's:default');
    const built = buildProfileChunks({ ...document, sectionOutline }, DOCUMENT, PROFILE);
    expect(built.children.length).toBeGreaterThan(0);
    expect(built.children.every((child) => child.metadata.section_outline === 'neutral-sheet@1')).toBe(true);
    expect(built.sectionOutline?.outline_id).toBe('neutral-sheet');
    expect(built.parents.map((parent) => parent.section_path)).toEqual([[], ...SECTION_PATHS(ALPHA_LABEL), ...SECTION_PATHS(BETA_LABEL)]);
  });
});

describe('saved state', () => {
  it('keeps a well-formed sectionOutline and drops a malformed one', () => {
    expect(ingestStateFromRecord({ sectionOutline: { outlineId: 'neutral-sheet', version: 1 } }).sectionOutline).toEqual({ outlineId: 'neutral-sheet', version: 1 });
    for (const bad of [
      { outlineId: 'Neutral Sheet', version: 1 },
      { outlineId: '', version: 1 },
      { outlineId: 'neutral-sheet', version: 0 },
      { outlineId: 'neutral-sheet', version: 1.5 },
      { outlineId: 'neutral-sheet', version: '1' },
      'neutral-sheet@1',
    ]) {
      expect('sectionOutline' in ingestStateFromRecord({ sectionOutline: bad }), JSON.stringify(bad)).toBe(false);
    }
    expect('sectionOutline' in ingestStateFromRecord({})).toBe(false);
  });
});
