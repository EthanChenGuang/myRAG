/**
 * Fixture pairs the content-overlap thresholds of config/rag/supersession-rules.json are fitted on (plan 03.2-45, D-41). Every text is a
 * neutral synthetic sample. `expected` says whether the pair should raise a candidate by content alone.
 */

export interface SupersessionPair {
  label: string;
  expected: boolean;
  a: string;
  b: string;
}

const join = (sentences: string[]) => sentences.join(' ');

const BASE = [
  'The blue widget weighs 12 grams and ships in boxes of 40 units.',
  'Each grey panel holds 6 brass screws spaced 15 millimetres apart.',
  'The copper rail is 120 centimetres long and rests on 3 brackets.',
  'Assembly takes about 25 minutes with two people working together.',
  'Store the finished frame in a dry room below 30 degrees.',
];

const LONG = [
  'The oak frame is 90 centimetres wide and 60 centimetres tall.',
  'Its glass cover is 4 millimetres thick and is cleaned with a soft cloth.',
  'Two hinges hold the cover and each hinge carries 2 small screws.',
  'The lower shelf carries at most 8 kilograms spread evenly.',
  'The upper shelf carries at most 5 kilograms spread evenly.',
  'A felt strip runs along the back edge to protect the wall.',
  'The frame is delivered flat in one carton with an assembly sheet.',
  'Spare screws are packed in a small bag taped inside the carton.',
  'The finish is a clear oil that is renewed once a year.',
  'Keep the frame away from direct heat and standing water.',
];

export const PAIRS: SupersessionPair[] = [
  {
    label: 'revision: three numbers changed, same sentences',
    expected: true,
    a: join(BASE),
    b: join([
      'The blue widget weighs 14 grams and ships in boxes of 40 units.',
      'Each grey panel holds 8 brass screws spaced 15 millimetres apart.',
      'The copper rail is 150 centimetres long and rests on 3 brackets.',
      ...BASE.slice(3),
    ]),
  },
  {
    label: 'revision: section added, two numbers changed',
    expected: true,
    a: join(BASE),
    b: join([
      'The blue widget weighs 13 grams and ships in boxes of 50 units.',
      ...BASE.slice(1),
      'A new silver clip now joins the rail to the frame.',
      'The clip is fitted before the panel is mounted.',
      'Replacement clips are sold in packs of 10.',
    ]),
  },
  {
    label: 'revision: three of ten sentences reworded, two numbers changed',
    expected: true,
    a: join(LONG),
    b: join([
      'The oak frame is 95 centimetres wide and 65 centimetres tall.',
      ...LONG.slice(1, 7),
      'Extra screws now come in a labelled box inside the carton.',
      'The finish is a matte wax that is renewed twice a year.',
      'Do not place the frame near heaters or damp floors.',
    ]),
  },
  {
    label: 'revision (zh): numbers changed',
    expected: true,
    a: '蓝色部件重 12 克，每箱 40 件。每块灰色面板用 6 颗铜螺丝固定。铜导轨长 120 厘米，放在 3 个支架上。两个人一起组装大约需要 25 分钟。',
    b: '蓝色部件重 15 克，每箱 40 件。每块灰色面板用 9 颗铜螺丝固定。铜导轨长 120 厘米，放在 3 个支架上。两个人一起组装大约需要 25 分钟。',
  },
  {
    label: 'revision (it): numbers changed',
    expected: true,
    a: 'Il componente blu pesa 12 grammi e viene spedito in scatole da 40 pezzi. Ogni pannello grigio ha 6 viti di ottone. La guida di rame è lunga 120 centimetri. Il montaggio richiede circa 25 minuti in due persone.',
    b: 'Il componente blu pesa 16 grammi e viene spedito in scatole da 40 pezzi. Ogni pannello grigio ha 7 viti di ottone. La guida di rame è lunga 140 centimetri. Il montaggio richiede circa 25 minuti in due persone.',
  },
  {
    label: 'different documents sharing a boilerplate paragraph',
    expected: false,
    a: join([
      'Keep the frame away from direct heat and standing water.',
      'The finish is a clear oil that is renewed once a year.',
      'The red lamp has a 40 watt bulb and a 2 metre cable.',
      'Its shade is made of folded paper and can be wiped clean.',
      'The switch sits on the cable about 50 centimetres from the plug.',
      'A spare bulb is packed in the base of the box.',
    ]),
    b: join([
      'Keep the frame away from direct heat and standing water.',
      'The finish is a clear oil that is renewed once a year.',
      'The green stool is 45 centimetres high with 3 legs.',
      'Its seat is carved from a single block of beech.',
      'The legs are glued and pinned with 6 wooden dowels.',
      'Felt pads under each leg protect the floor.',
    ]),
  },
  {
    label: 'light edit with the same numbers',
    expected: false,
    a: join(BASE),
    b: join([...BASE.slice(0, 4), 'Store the finished frame in a dry cellar below 30 degrees.']),
  },
  {
    label: 'only a footer number differs',
    expected: false,
    a: `${join(BASE)} Page 1 of 3.`,
    b: `${join(BASE)} Page 2 of 3.`,
  },
  {
    label: 'low overlap although numbers differ',
    expected: false,
    a: join([...LONG.slice(0, 2), 'The walnut desk has 4 drawers.', 'Each drawer runs on 2 metal slides.', 'The top is 140 centimetres long.', 'Its legs are 72 centimetres tall.', 'The desk ships in 3 cartons.', 'A cable tray sits under the top.']),
    b: join([
      'The oak frame is 80 centimetres wide and 50 centimetres tall.',
      'Its glass cover is 6 millimetres thick and is cleaned with a soft cloth.',
      'The pine bench seats 3 people.',
      'Its seat is 40 centimetres deep.',
      'The bench weighs 18 kilograms.',
      'It ships in one carton.',
      'Two cross bars brace the legs.',
      'The finish is a white stain.',
    ]),
  },
  {
    label: 'unrelated documents',
    expected: false,
    a: join(BASE),
    b: join(LONG),
  },
];
