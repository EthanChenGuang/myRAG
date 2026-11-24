import type { RagConfig, StageName } from '../../config';
import { LEGACY_PROFILE } from '../../embeddings/active-profile';
import type { QueryEmbedding } from '../../embeddings/query-embedding';
import type { FusedHit } from '../../fusion/rrf';
import { LEXICAL_VERSION } from '../../lexical/chunk-text';
import { runStage, stageSpec, type StageSpec } from '../../pipeline';
import { decideRefusal, type QueryLanguage } from '../../refusal/gate';
import { floorsFromCalibration, similarityFloor } from '../../refusal/floor';
import { loadThresholds } from '../../refusal/thresholds';
import type { RefusalRecord } from '../../refusal/types';
import { RERANK_TEXT_VERSION } from '../../rerank/types';
import type { TraceCollector } from '../../trace/collector';
import type { Profile, ReferencedState, RunRetrievalInput, StageOverrides } from '../../types';

export interface RankStagesInput {
  input: RunRetrievalInput;
  config: RagConfig;
  profile: Profile;
  embedding: QueryEmbedding;
  queryLanguage: QueryLanguage | null;
  fusedHits: FusedHit[];
  referenced: ReferencedState | null;
  signal: AbortSignal;
  collector: TraceCollector;
  stageOverrides?: StageOverrides;
}

export interface RankStagesOutput {
  decision: RefusalRecord;
  survivors: FusedHit[];
  preRefusalHits: FusedHit[];
}

function hitHasImage(hit: FusedHit['hit']): boolean {
  const meta = hit.metadata as Record<string, unknown> | null;
  if (meta?.image_url) return true;
  const name = hit.document.filename.toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].some((ext) => name.endsWith(ext));
}

function applyRefusal(
  config: RagConfig,
  profile: Profile,
  embedding: QueryEmbedding,
  queryLanguage: QueryLanguage | null,
  fusedHits: FusedHit[],
): RefusalRecord {
  const { cells } = loadThresholds();
  const gate = decideRefusal({
    enabled: config.v2.refusalThreshold,
    profile,
    reranker: null,
    rerankStatus: 'disabled',
    reranked: [],
    queryLanguage,
    cells,
    versions: { lexical: LEXICAL_VERSION, rerankText: RERANK_TEXT_VERSION },
  });
  if (gate.decision !== 'not_applied') return gate;

  const calibration = embedding.profile?.scoreCalibration ?? LEGACY_PROFILE.scoreCalibration;
  const floors = floorsFromCalibration(calibration as Record<string, unknown>);
  return similarityFloor({
    floors,
    candidates: fusedHits.map((row) => ({
      similarity: row.hit.similarity,
      hasImage: hitHasImage(row.hit),
    })),
  });
}

export async function runRankStages(ctx: RankStagesInput): Promise<RankStagesOutput> {
  const { input, config, profile, embedding, queryLanguage, fusedHits, signal, collector, stageOverrides } = ctx;
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);
  const preRefusalHits = fusedHits;

  const refused = await runStage(
    spec('refusal', 'skip'),
    signal,
    async () => applyRefusal(config, profile, embedding, queryLanguage, fusedHits),
    collector,
    {
      candidatesIn: fusedHits.length,
      counts: (record): Record<string, number> => {
        if (record.decision === 'refuse') return { refused: 1 };
        if (record.decision === 'answer') return { answered: 1 };
        return { not_applied: 1 };
      },
      detail: (record) => (record.basis !== 'none' ? record.basis : record.reason),
    },
  );

  const decision = refused.skipped
    ? applyRefusal(config, profile, embedding, queryLanguage, fusedHits)
    : refused.value;

  const survivors = decision.decision === 'refuse' ? [] : fusedHits;
  return { decision, survivors, preRefusalHits };
}