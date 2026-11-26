export interface PromptDirectives {
  languages: Record<string, { directives: RegExp[]; negations: RegExp[] }>;
}

export function loadPromptDirectives(): PromptDirectives {
  return { languages: {} };
}

export function hasRefusalDirective(_prompt: string): boolean {
  return false;
}
