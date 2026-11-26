export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface QuestionsImportCliDeps {
  env?: Record<string, string | undefined>;
  createClient?: (url: string, key: string) => unknown;
  now?: Date;
}

export async function main(_argv: string[] = [], _io?: CliIo, _deps: QuestionsImportCliDeps = {}): Promise<number> {
  return -1;
}
