export const STATUS_CONTEXT = 'rag-release-gate';

export function statusFromResult() {
  return { state: 'pending', description: '' };
}

export async function postStatus() {
  return 0;
}

export async function main() {
  return 2;
}
