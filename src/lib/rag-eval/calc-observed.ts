import type { CalcResult, CalcTrace, RagTrace } from '@/lib/rag-eval/contracts.generated';
import { locateStatedNumber, stepsListed } from '@/lib/rag/calc/check';
import { evaluateCalc } from '@/lib/rag/calc/evaluate';
import { display, equals, parseDecimal, rational, type Rational } from '@/lib/rag/calc/rational';

export type CalcObserved = NonNullable<RagTrace['calc_observed']>;

const DECIMAL_STRING = /^-?[0-9]{1,30}(\.[0-9]{1,30})?$/;
const ISO_DATE_SHAPE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

type Request = CalcTrace['request'];

function chunkAliases(request: Request): Set<string> {
  const aliases = new Set<string>();
  for (const operand of request.operands) {
    if (operand.source.kind === 'chunk' && operand.source.alias !== undefined) aliases.add(operand.source.alias);
  }
  return aliases;
}

function operandValues(request: Request): Rational[] {
  const values: Rational[] = [];
  for (const operand of request.operands) {
    if (operand.values !== undefined) values.push(...operand.values.map((value) => parseDecimal(value)));
    else if (operand.value !== undefined && !ISO_DATE_SHAPE.test(operand.value)) values.push(parseDecimal(operand.value));
  }
  return values;
}

function exactOf(text: string): Rational {
  const slash = text.indexOf('/');
  return rational(BigInt(text.slice(0, slash)), BigInt(text.slice(slash + 1)));
}

function decimalOf(value: Rational): string | null {
  const text = display(value).display;
  return DECIMAL_STRING.test(text) ? text : null;
}

/** A trace's result: the tool's own for a tool trace, else recomputed over the aliases the turn offered. */
function resultOf(trace: CalcTrace, offered: ReadonlySet<string>): CalcResult {
  if (trace.result && trace.result.status === 'ok') return trace.result;
  const aliases = new Set<string>();
  for (const alias of chunkAliases(trace.request)) if (offered.has(alias)) aliases.add(alias);
  return evaluateCalc(trace.request, { aliases });
}

/**
 * D-77: what the answer showed of a calculation, recorded on every generated eval answer whether the check is on or off. The
 * stated number follows the check's D-95 rule for the last calculation of the answer (operand and intermediate values are
 * skipped unless they equal the result); without a calculation it is the number nearest the end of the answer.
 */
export function observeCalc(input: {
  rawText: string;
  traces: readonly CalcTrace[];
  /** The context-block aliases of the turn. */
  aliases: ReadonlySet<string>;
  language: string | null;
}): CalcObserved {
  const { rawText, traces } = input;
  const primary = traces.length > 0 ? traces[traces.length - 1] : null;
  const observed: CalcObserved = {
    stated: null,
    steps_listed: false,
    tool_used: traces.some((trace) => trace.origin === 'tool'),
    origin: primary?.origin ?? null,
  };
  if (!input.language) return observed;
  const language = input.language;
  try {
    if (!primary) {
      const stated = locateStatedNumber(rawText, { aliases: input.aliases, excluded: [], anchor: rawText.length, language });
      return { ...observed, stated: stated ? decimalOf(stated.value) : null };
    }
    const result = resultOf(primary, input.aliases);
    const excluded = operandValues(primary.request);
    let resultValue: Rational | null = null;
    if (result.status === 'ok') {
      const steps = result.steps ?? [];
      const final = steps.find((step) => step.id === primary.request.result);
      if (final) resultValue = exactOf(final.exact);
      for (const step of steps) if (step.id !== primary.request.result) excluded.push(exactOf(step.exact));
    }
    const candidates = resultValue === null ? excluded : excluded.filter((value) => !equals(value, resultValue));
    const stated = locateStatedNumber(rawText, {
      aliases: chunkAliases(primary.request),
      excluded: candidates,
      anchor: primary.anchor_offset ?? rawText.length,
      language,
    });
    return {
      ...observed,
      stated: stated ? decimalOf(stated.value) : null,
      steps_listed: stepsListed(rawText, primary, result, language, stated?.start),
    };
  } catch {
    return observed;
  }
}
