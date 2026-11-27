export interface ToolCapabilityInput {
  provider: string | null | undefined;
  modelId: string;
}

export function modelBlocksTools(_modelId: string): boolean {
  return false;
}

export function turnCanUseTools(_input: ToolCapabilityInput): boolean {
  return false;
}
