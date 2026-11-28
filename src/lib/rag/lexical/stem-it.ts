// Port of the Snowball Italian stemmer (algorithms/italian.sbl, 3-clause BSD; notice in
// tests/fixtures/snowball-italian/COPYING). Input: a lowercase word before accent folding.

const VOWELS = new Set([...'aeiouàèìòù']);
const AEIO = new Set([...'aeioàèìò']);
const ACUTE_TO_GRAVE: Record<string, string> = { á: 'à', é: 'è', í: 'ì', ó: 'ò', ú: 'ù' };

const ELISIONS = sortLongestFirst([
  "d'", "l'", "m'", "s'", "t'", "v'", "all'", "dall'", "dell'", "gl'", "nell'", "quell'", "quest'", "sull'", "tutt'", "un'",
]);

const PRONOUNS = sortLongestFirst([
  'ci', 'gli', 'la', 'le', 'li', 'lo', 'mi', 'ne', 'si', 'ti', 'vi',
  'sene', 'gliela', 'gliele', 'glieli', 'glielo', 'gliene',
  'mela', 'mele', 'meli', 'melo', 'mene', 'tela', 'tele', 'teli', 'telo', 'tene',
  'cela', 'cele', 'celi', 'celo', 'cene', 'vela', 'vele', 'veli', 'velo', 'vene',
]);
const PRONOUN_HOSTS = sortLongestFirst(['ando', 'endo', 'ar', 'er', 'ir']);

type StandardAction =
  | 'r2_delete'
  | 'azione'
  | 'logia'
  | 'uzione'
  | 'enza'
  | 'amento'
  | 'amente'
  | 'ita'
  | 'ivo';

const STANDARD_GROUPS: Array<[StandardAction, string[]]> = [
  [
    'r2_delete',
    [
      'anza', 'anze', 'ico', 'ici', 'ica', 'ice', 'iche', 'ichi', 'ismo', 'ismi', 'abile', 'abili', 'ibile', 'ibili',
      'ista', 'iste', 'isti', 'istà', 'istè', 'istì', 'oso', 'osi', 'osa', 'ose', 'mente', 'atrice', 'atrici', 'ante', 'anti',
    ],
  ],
  ['azione', ['azione', 'azioni', 'atore', 'atori']],
  ['logia', ['logia', 'logie']],
  ['uzione', ['uzione', 'uzioni', 'usione', 'usioni']],
  ['enza', ['enza', 'enze']],
  ['amento', ['amento', 'amenti', 'imento', 'imenti']],
  ['amente', ['amente']],
  ['ita', ['ità']],
  ['ivo', ['ivo', 'ivi', 'iva', 'ive']],
];
const STANDARD_SUFFIXES = sortLongestFirst(STANDARD_GROUPS.flatMap(([, list]) => list));
const STANDARD_ACTION = new Map<string, StandardAction>(
  STANDARD_GROUPS.flatMap(([action, list]) => list.map((suffix): [string, StandardAction] => [suffix, action])),
);

const VERB_SUFFIXES = sortLongestFirst([
  'ammo', 'ando', 'ano', 'are', 'arono', 'asse', 'assero', 'assi', 'assimo', 'ata', 'ate', 'ati', 'ato', 'ava', 'avamo',
  'avano', 'avate', 'avi', 'avo', 'emmo', 'enda', 'ende', 'endi', 'endo', 'erà', 'erai', 'eranno', 'ere', 'erebbe',
  'erebbero', 'erei', 'eremmo', 'eremo', 'ereste', 'eresti', 'erete', 'erò', 'erono', 'essero', 'ete', 'eva', 'evamo',
  'evano', 'evate', 'evi', 'evo', 'Yamo', 'iamo', 'immo', 'irà', 'irai', 'iranno', 'ire', 'irebbe', 'irebbero', 'irei',
  'iremmo', 'iremo', 'ireste', 'iresti', 'irete', 'irò', 'irono', 'isca', 'iscano', 'isce', 'isci', 'isco', 'iscono',
  'issero', 'ita', 'ite', 'iti', 'ito', 'iva', 'ivamo', 'ivano', 'ivate', 'ivi', 'ivo', 'ono', 'uta', 'ute', 'uti', 'uto',
  'ar', 'ir',
]);

function sortLongestFirst(list: string[]): string[][] {
  return list.map((item) => [...item]).sort((a, b) => b.length - a.length);
}

function isVowel(ch: string | undefined): boolean {
  return ch !== undefined && VOWELS.has(ch);
}

function isNonVowel(ch: string | undefined): boolean {
  return ch !== undefined && !VOWELS.has(ch);
}

function startsWith(word: string[], prefix: string[]): boolean {
  if (prefix.length > word.length) return false;
  return prefix.every((ch, index) => word[index] === ch);
}

function endsAt(word: string[], suffix: string[], end: number, limit: number): boolean {
  const start = end - suffix.length;
  if (start < limit) return false;
  return suffix.every((ch, index) => word[start + index] === ch);
}

/** Longest suffix of `list` ending at `end` that does not start before `limit`. */
function longestSuffix(word: string[], list: string[][], end: number, limit = 0): string[] | null {
  for (const suffix of list) if (endsAt(word, suffix, end, limit)) return suffix;
  return null;
}

function elisions(word: string[]): string[] {
  for (const prefix of ELISIONS) {
    if (startsWith(word, prefix)) return word.length > prefix.length ? word.slice(prefix.length) : word;
  }
  return word;
}

function prelude(input: string[]): string[] {
  const word: string[] = [];
  for (let i = 0; i < input.length; ) {
    const ch = input[i]!;
    if (ch === 'q' && input[i + 1] === 'u') {
      word.push('q', 'U');
      i += 2;
    } else {
      word.push(ACUTE_TO_GRAVE[ch] ?? ch);
      i += 1;
    }
  }
  let cursor = 0;
  for (;;) {
    let found = -1;
    for (let s = cursor; s + 2 < word.length; s += 1) {
      if (isVowel(word[s]) && (word[s + 1] === 'u' || word[s + 1] === 'i') && isVowel(word[s + 2])) {
        found = s;
        break;
      }
    }
    if (found < 0) break;
    word[found + 1] = word[found + 1] === 'u' ? 'U' : 'I';
    cursor = found + 3;
  }
  return word;
}

function gopast(word: string[], from: number, test: (ch: string | undefined) => boolean): number {
  for (let i = from; i < word.length; i += 1) if (test(word[i])) return i + 1;
  return -1;
}

const DIVAN = [...'divan'];

function markRegions(word: string[]): { pV: number; p1: number; p2: number } {
  const n = word.length;
  let pV = n;
  let p1 = n;
  let p2 = n;

  const rv = ((): number => {
    if (isVowel(word[0])) {
      if (isNonVowel(word[1])) {
        const at = gopast(word, 2, isVowel);
        if (at >= 0) return at;
      }
      if (isVowel(word[1])) {
        const at = gopast(word, 2, isNonVowel);
        if (at >= 0) return at;
      }
    }
    if (startsWith(word, DIVAN)) return DIVAN.length;
    if (isNonVowel(word[0])) {
      if (isNonVowel(word[1])) {
        const at = gopast(word, 2, isVowel);
        if (at >= 0) return at;
      }
      if (isVowel(word[1]) && n > 2) return 3;
    }
    return -1;
  })();
  if (rv >= 0) pV = rv;

  const a = gopast(word, 0, isVowel);
  const b = a < 0 ? -1 : gopast(word, a, isNonVowel);
  if (b >= 0) {
    p1 = b;
    const c = gopast(word, b, isVowel);
    const d = c < 0 ? -1 : gopast(word, c, isNonVowel);
    if (d >= 0) p2 = d;
  }
  return { pV, p1, p2 };
}

interface StemState {
  word: string[];
  pV: number;
  p1: number;
  p2: number;
}

function replaceTail(state: StemState, start: number, replacement: string): void {
  state.word.splice(start, state.word.length - start, ...replacement);
}

function attachedPronoun(state: StemState): void {
  const end = state.word.length;
  const pronoun = longestSuffix(state.word, PRONOUNS, end);
  if (!pronoun) return;
  const bra = end - pronoun.length;
  const host = longestSuffix(state.word, PRONOUN_HOSTS, bra);
  if (!host) return;
  if (state.pV > bra - host.length) return;
  const hostText = host.join('');
  replaceTail(state, bra, hostText === 'ando' || hostText === 'endo' ? '' : 'e');
}

/** Deletes `suffix` at the end when it is present and starts at or after `region`. */
function deleteIfIn(state: StemState, suffix: string[] | string, region: number): boolean {
  const chars = typeof suffix === 'string' ? [...suffix] : suffix;
  const end = state.word.length;
  if (!endsAt(state.word, chars, end, 0)) return false;
  const start = end - chars.length;
  if (region > start) return false;
  replaceTail(state, start, '');
  return true;
}

const AMENTE_FOLLOW = sortLongestFirst(['iv', 'os', 'ic', 'abil']);
const ITA_FOLLOW = sortLongestFirst(['abil', 'ic', 'iv']);

function standardSuffix(state: StemState): boolean {
  const end = state.word.length;
  const suffix = longestSuffix(state.word, STANDARD_SUFFIXES, end);
  if (!suffix) return false;
  const bra = end - suffix.length;
  const action = STANDARD_ACTION.get(suffix.join(''))!;
  const { pV, p1, p2 } = state;
  switch (action) {
    case 'r2_delete':
      if (p2 > bra) return false;
      replaceTail(state, bra, '');
      return true;
    case 'azione':
      if (p2 > bra) return false;
      replaceTail(state, bra, '');
      deleteIfIn(state, 'ic', p2);
      return true;
    case 'logia':
      if (p2 > bra) return false;
      replaceTail(state, bra, 'log');
      return true;
    case 'uzione':
      if (p2 > bra) return false;
      replaceTail(state, bra, 'u');
      return true;
    case 'enza':
      if (p2 > bra) return false;
      replaceTail(state, bra, 'ente');
      return true;
    case 'amento':
      if (pV > bra) return false;
      replaceTail(state, bra, '');
      return true;
    case 'amente': {
      if (p1 > bra) return false;
      replaceTail(state, bra, '');
      const follow = longestSuffix(state.word, AMENTE_FOLLOW, state.word.length);
      if (follow && deleteIfIn(state, follow, p2) && follow.join('') === 'iv') deleteIfIn(state, 'at', p2);
      return true;
    }
    case 'ita': {
      if (p2 > bra) return false;
      replaceTail(state, bra, '');
      const follow = longestSuffix(state.word, ITA_FOLLOW, state.word.length);
      if (follow) deleteIfIn(state, follow, p2);
      return true;
    }
    case 'ivo':
      if (p2 > bra) return false;
      replaceTail(state, bra, '');
      if (deleteIfIn(state, 'at', p2)) deleteIfIn(state, 'ic', p2);
      return true;
  }
}

function verbSuffix(state: StemState): void {
  const end = state.word.length;
  if (end < state.pV) return;
  const suffix = longestSuffix(state.word, VERB_SUFFIXES, end, state.pV);
  if (suffix) replaceTail(state, end - suffix.length, '');
}

function vowelSuffix(state: StemState): void {
  const { word, pV } = state;
  const last = word.length - 1;
  if (last >= 0 && AEIO.has(word[last]!) && pV <= last) {
    word.pop();
    const next = word.length - 1;
    if (next >= 0 && word[next] === 'i' && pV <= next) word.pop();
  }
  const h = word.length - 1;
  if (h >= 1 && word[h] === 'h' && (word[h - 1] === 'c' || word[h - 1] === 'g') && pV <= h - 1) word.pop();
}

function postlude(word: string[]): string {
  return word.map((ch) => (ch === 'I' ? 'i' : ch === 'U' ? 'u' : ch)).join('');
}

/** Snowball Italian stem of a lowercase, unfolded word. */
export function stemItalian(word: string): string {
  if (word === '') return '';
  const prepared = prelude(elisions([...word]));
  const state: StemState = { word: prepared, ...markRegions(prepared) };
  attachedPronoun(state);
  if (!standardSuffix(state)) verbSuffix(state);
  vowelSuffix(state);
  return postlude(state.word);
}
