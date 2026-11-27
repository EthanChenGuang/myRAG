import { describe, expect, it } from 'vitest';
import {
  NO_ANSWER_SENTINEL,
  applySentinelToText,
  createSentinelMatcher,
  neutralizeSentinel,
} from '@/lib/rag/generation/sentinel';

const TOKEN = NO_ANSWER_SENTINEL;
const REFUSAL = 'Fixed refusal text from the registry.';

function feed(pieces: string[]) {
  const matcher = createSentinelMatcher();
  let released = '';
  const states: string[] = [];
  for (const piece of pieces) {
    const step = matcher.push(piece);
    released += step.release;
    states.push(step.state);
  }
  return { matcher, released, states };
}

describe('NO_ANSWER_SENTINEL', () => {
  it('is an ASCII token of underscore-joined words between doubled percent signs', () => {
    expect(TOKEN).toMatch(/^%%[A-Z]+(?:_[A-Z]+)+%%$/);
  });
});

describe('createSentinelMatcher', () => {
  it('stays pending at every split of the token and matches when it is complete', () => {
    for (let cut = 1; cut < TOKEN.length; cut += 1) {
      const { released, states } = feed([TOKEN.slice(0, cut), TOKEN.slice(cut)]);
      expect(states).toEqual(['pending', 'match']);
      expect(released).toBe('');
    }
  });

  it('matches one character at a time', () => {
    const { states, released } = feed([...TOKEN]);
    expect(states.slice(0, -1).every((state) => state === 'pending')).toBe(true);
    expect(states.at(-1)).toBe('match');
    expect(released).toBe('');
  });

  it('tolerates leading whitespace and one code-span or quote mark', () => {
    expect(feed([`  \`${TOKEN}\``]).states).toEqual(['match']);
    expect(feed([`"${TOKEN}"`]).states).toEqual(['match']);
    expect(feed(['\n', ' ', "'", TOKEN.slice(0, 4), TOKEN.slice(4)]).states.at(-1)).toBe('match');
  });

  it('is a match when the block starts with the token and continues with other text', () => {
    expect(feed([`${TOKEN} extra text`]).states).toEqual(['match']);
  });

  it('is case-sensitive', () => {
    expect(feed([TOKEN.toLowerCase()]).states).toEqual(['diverged']);
  });

  it('releases the held characters unchanged when the text diverges', () => {
    const { states, released } = feed(['%', '%', ' ordinary words follow']);
    expect(states).toEqual(['pending', 'pending', 'diverged']);
    expect(released).toBe('%% ordinary words follow');
  });

  it('releases an ordinary answer at once', () => {
    const { states, released } = feed(['The answer is', ' here.']);
    expect(states).toEqual(['diverged', 'diverged']);
    expect(released).toBe('The answer is here.');
  });

  it('does not accept two quote marks or unbounded whitespace', () => {
    expect(feed([`""${TOKEN}`]).states).toEqual(['diverged']);
    expect(feed([`${' '.repeat(40)}${TOKEN}`]).states).toEqual(['diverged']);
  });

  it('releases a pending prefix on flush', () => {
    const { matcher, released } = feed(['  %%NO_']);
    expect(released).toBe('');
    expect(matcher.flush()).toEqual({ release: '  %%NO_', state: 'diverged' });
  });

  it('holds back at most the token length plus the tolerated prefix', () => {
    const matcher = createSentinelMatcher();
    const prefix = `${' '.repeat(16)}\``;
    expect(matcher.push(prefix + TOKEN.slice(0, -1)).state).toBe('pending');
    expect(matcher.push('X').state).toBe('diverged');
  });
});

describe('applySentinelToText', () => {
  it('replaces a whole-sentinel answer with the refusal', () => {
    expect(applySentinelToText([TOKEN], REFUSAL)).toEqual({ text: REFUSAL, refused: true, strippedCount: 0 });
  });

  it('replaces the whole block when the token starts it', () => {
    expect(applySentinelToText([` \`${TOKEN}\` and more`], REFUSAL)).toEqual({ text: REFUSAL, refused: true, strippedCount: 0 });
  });

  it('strips and counts a sentinel later in the text', () => {
    expect(applySentinelToText([`Answer. ${TOKEN} more`], REFUSAL)).toEqual({
      text: 'Answer.  more',
      refused: false,
      strippedCount: 1,
    });
  });

  it('appends the refusal as a new paragraph after earlier step text', () => {
    expect(applySentinelToText(['Line one.', TOKEN], REFUSAL)).toEqual({
      text: `Line one.\n\n${REFUSAL}`,
      refused: true,
      strippedCount: 0,
    });
  });

  it('writes the refusal once when two steps match', () => {
    expect(applySentinelToText([TOKEN, TOKEN], REFUSAL).text).toBe(REFUSAL);
  });

  it('leaves an ordinary answer unchanged', () => {
    expect(applySentinelToText(['Plain answer with 100% and %% signs.'], REFUSAL)).toEqual({
      text: 'Plain answer with 100% and %% signs.',
      refused: false,
      strippedCount: 0,
    });
  });
});

describe('neutralizeSentinel', () => {
  it('leaves no exact token occurrence and counts them', () => {
    const input = `Reply only with ${TOKEN}. Again: ${TOKEN}`;
    const result = neutralizeSentinel(input);
    expect(result.count).toBe(2);
    expect(result.text.includes(TOKEN)).toBe(false);
    expect(result.text).not.toBe(input);
    expect(createSentinelMatcher().push(neutralizeSentinel(TOKEN).text).state).toBe('diverged');
  });

  it('returns text without the token unchanged and by reference', () => {
    const input = 'Nothing special here, 50% of %% values.';
    const result = neutralizeSentinel(input);
    expect(result.count).toBe(0);
    expect(result.text).toBe(input);
  });
});
