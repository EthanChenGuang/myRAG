import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';

export function isV2Pipeline(): boolean {
  return loadRagConfig(getRagDeps().ragEnv()).pipeline === 'v2';
}
