import type { QueryClassification } from '@/lib/query-classifier';
import type { QueryFramework, QueryLayerConfig, QueryTransformSwitches, VoiceTransform } from '../config';
import type { Profile } from '../types';
import type { GateResult, Transform } from './rewrite-gate';

/** Query-layer stage names a routed transform runs under (D-05). */
export type RoutedTransform = 'condense' | 'normalize_dates' | 'translate' | 'expand' | 'hyde' | 'decompose';
export type RouteSkipReason = 'disabled' | 'disabled_for_profile' | 'classifier_tool' | 'voice_blocked';

/** A transform the router chose not to run. Routing decisions are config, so the status is always disabled, never degraded (D-28). */
export interface RouteSkip {
  transform: RoutedTransform;
  reason: RouteSkipReason;
  status: 'disabled';
}

export interface RoutedTransforms {
  transforms: RoutedTransform[];
  skipped: RouteSkip[];
  skipRetrieval: boolean;
  framework: QueryFramework;
}

export interface RouteInput {
  gate: GateResult;
  /** The entry point's single classifyQuery result (D-09); never computed here. */
  classification?: QueryClassification | null;
  config: QueryLayerConfig;
  profile: Profile;
  embeddingProfileId: string;
}

/** D-05 order: condense first, then the parallel group. */
const ROUTE_ORDER: readonly RoutedTransform[] = ['condense', 'normalize_dates', 'translate', 'expand', 'hyde', 'decompose'];

const FROM_GATE: Record<Transform, RoutedTransform> = {
  condense_history: 'condense',
  normalize_dates: 'normalize_dates',
  decompose: 'decompose',
  expand: 'expand',
  translate: 'translate',
};

const SWITCH: Record<RoutedTransform, keyof QueryTransformSwitches> = {
  condense: 'condense',
  normalize_dates: 'normalizeDates',
  translate: 'translate',
  expand: 'expand',
  hyde: 'hyde',
  decompose: 'decompose',
};

/** Hard block, independent of config (D-30): voice never runs these. */
const VOICE_BLOCKED: ReadonlySet<RoutedTransform> = new Set(['expand', 'hyde', 'decompose']);
const VOICE_ALLOWED: Readonly<Record<VoiceTransform, RoutedTransform>> = {
  condense_history: 'condense',
  normalize_dates: 'normalize_dates',
  translate: 'translate',
};

function voiceAllowList(config: QueryLayerConfig): Set<RoutedTransform> {
  const allowed = new Set<RoutedTransform>();
  for (const name of config.voiceTransforms) {
    const routed = VOICE_ALLOWED[name as VoiceTransform];
    if (routed) allowed.add(routed);
  }
  return allowed;
}

/** A-1: only tool_required with needsMcp and multi_step carry a signal; every other category is ignored. */
function classifierTool(classification: QueryClassification | null | undefined): boolean {
  return classification?.category === 'tool_required' && classification.needsMcp === true;
}

/** Turns the gate result, classifier result, switches and profile into the transforms to run (QRY-05, D-09/A-1). */
export function routeTransforms(input: RouteInput): RoutedTransforms {
  const { gate, classification, config, profile, embeddingProfileId } = input;
  const voice = profile === 'voice';
  const framework: QueryFramework = voice ? 'llamaindex' : config.framework;

  if (!config.enabled) {
    return { transforms: [], skipped: [], skipRetrieval: false, framework };
  }
  if (gate.skipRetrieval) {
    return { transforms: [], skipped: [], skipRetrieval: true, framework };
  }

  const candidates = new Set<RoutedTransform>(gate.transforms.map((transform) => FROM_GATE[transform]));
  if (classification?.category === 'multi_step') candidates.add('decompose');
  if (candidates.has('expand')) candidates.add('hyde');

  const toolOnly = classifierTool(classification);
  const voiceAllowed = voice ? voiceAllowList(config) : null;
  const transforms: RoutedTransform[] = [];
  const skipped: RouteSkip[] = [];
  const skip = (transform: RoutedTransform, reason: RouteSkipReason) => skipped.push({ transform, reason, status: 'disabled' });

  for (const transform of ROUTE_ORDER) {
    if (!candidates.has(transform)) continue;
    if (toolOnly) skip(transform, 'classifier_tool');
    else if (voice && VOICE_BLOCKED.has(transform)) skip(transform, 'voice_blocked');
    else if (voiceAllowed && !voiceAllowed.has(transform)) skip(transform, 'disabled');
    else if (!config.transforms[SWITCH[transform]]) skip(transform, 'disabled');
    else if (transform === 'translate' && config.translateDisabledProfiles.includes(embeddingProfileId)) skip(transform, 'disabled_for_profile');
    else transforms.push(transform);
  }

  return { transforms, skipped, skipRetrieval: false, framework };
}
