import type { QueryClassification } from '@/lib/query-classifier';
import type { QueryFramework, QueryLayerConfig } from '../config';
import type { Profile } from '../types';
import type { GateResult } from './rewrite-gate';

export type RoutedTransform = 'condense' | 'normalize_dates' | 'translate' | 'expand' | 'hyde' | 'decompose';
export type RouteSkipReason = 'disabled' | 'disabled_for_profile' | 'classifier_tool' | 'voice_blocked';

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
  classification?: QueryClassification | null;
  config: QueryLayerConfig;
  profile: Profile;
  embeddingProfileId: string;
}

export function routeTransforms(_input: RouteInput): RoutedTransforms {
  return { transforms: [], skipped: [], skipRetrieval: false, framework: 'llamaindex' };
}
