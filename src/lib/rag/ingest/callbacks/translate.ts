import type { TranslateCallbackRequest, TranslateCallbackResponse } from '@/lib/rag-eval/contracts.generated';
import { refuse, type CallbackResult } from './common';

export async function handleTranslateCallback(
  _jobId: string,
  _body: TranslateCallbackRequest,
  _options: { signal: AbortSignal },
): Promise<CallbackResult<TranslateCallbackResponse>> {
  return refuse(500, 'not_implemented');
}
