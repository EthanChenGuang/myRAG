import type { QueryLayerConfig, QueryTransformSwitches } from '../config';
import type { Profile, QueryLayerOverrides, StageOverrides } from '../types';

/** D-38: request overrides apply to the eval profile only, following the Phase 4 requestOverrides gate. */
export function queryLayerOverrides(profile: Profile, overrides: StageOverrides | undefined): QueryLayerOverrides | undefined {
  return profile === 'eval' ? overrides?.queryLayer : undefined;
}

/** The request's query-layer config: the environment, overlaid with the eval-only request overrides (D-38). */
export function effectiveQueryLayerConfig(base: QueryLayerConfig, overrides: QueryLayerOverrides | undefined): QueryLayerConfig {
  if (!overrides) return base;
  const transforms = { ...base.transforms };
  for (const [name, value] of Object.entries(overrides.transforms ?? {}) as Array<[keyof QueryTransformSwitches, boolean | undefined]>) {
    if (typeof value === 'boolean' && name in transforms) transforms[name] = value;
  }
  return {
    ...base,
    enabled: overrides.enabled === false ? false : base.enabled,
    framework: overrides.framework ?? base.framework,
    transforms,
  };
}
