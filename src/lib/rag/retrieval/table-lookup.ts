export async function tableLookup(..._args: unknown[]): Promise<never[]> {
  return [];
}

export async function tableLookupStage(..._args: unknown[]): Promise<{ rows: never[]; tokenCount: number }> {
  return { rows: [], tokenCount: -1 };
}
