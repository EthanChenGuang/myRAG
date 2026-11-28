/**
 * Checksum-bearing identifier shapes, written by hand on purpose and held to the sidecar's python-stdnum answers by the shared
 * vector fixture (tests/rag/checksum-id-vectors.test.ts). The eleven-digit shape, the eighteen-character shape and the
 * country-prefixed shapes of the countries below carry a checksum; any other two-letter prefix is reported as not valid (such a
 * token is still looked up as an ordinary identifier). Scheme values are a sidecar contract and keep their spelling.
 */
export type ChecksumIdScheme = 'it_iva' | 'cn_uscc' | 'eu_vat' | 'unknown';

export interface ChecksumIdCheck {
  scheme: ChecksumIdScheme;
  valid: boolean;
  normalized: string;
}

const SEPARATORS = /[\s.\-/_]/gu;
const ELEVEN_DIGIT_SHAPE = /^\d{11}$/;
const EIGHTEEN_CHAR_SHAPE = /^[0-9A-Z]{18}$/;
const COUNTRY_PREFIXED_SHAPE = /^[A-Z]{2}[0-9A-Z]{2,12}$/;
const EIGHTEEN_CHAR_ALPHABET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const EIGHTEEN_CHAR_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
const DIGITS = /^\d+$/;

export function normalizeChecksumId(raw: string): string {
  return raw.replace(SEPARATORS, '').toUpperCase();
}

function luhnChecksum(digits: string): number {
  let total = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const value = digits.charCodeAt(digits.length - 1 - index) - 48;
    if (index % 2 === 0) {
      total += value;
    } else {
      const doubled = value * 2;
      total += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  return total % 10;
}

function alnumMod97(text: string): number {
  let remainder = 0;
  for (const character of text) {
    const value = Number.parseInt(character, 36);
    const piece = String(value);
    for (const digit of piece) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder;
}

function validItalian(body: string): boolean {
  if (!ELEVEN_DIGIT_SHAPE.test(body) || Number(body.slice(0, 7)) === 0) return false;
  const province = body.slice(7, 10);
  const provinceOk = (province >= '001' && province <= '100') || province === '120' || province === '121' || province === '888' || province === '999';
  return provinceOk && luhnChecksum(body) === 0;
}

function validGerman(body: string): boolean {
  if (!DIGITS.test(body) || body.startsWith('0') || body.length !== 9) return false;
  let check = 5;
  for (const digit of body) check = ((((check || 10) * 2) % 11) + (digit.charCodeAt(0) - 48)) % 10;
  return check === 1;
}

function validFrench(body: string): boolean {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  if (body.length !== 11 || ![...body.slice(0, 2)].every((character) => alphabet.includes(character)) || !DIGITS.test(body.slice(2))) return false;
  const siren = body.slice(2);
  if (body.slice(2, 5) !== '000' && luhnChecksum(siren) !== 0) return false;
  if (DIGITS.test(body)) return Number(body.slice(0, 2)) === (Number(siren + '12') % 97);
  const first = alphabet.indexOf(body[0] as string);
  const second = alphabet.indexOf(body[1] as string);
  const check = DIGITS.test(body[0] as string) ? first * 24 + second - 10 : first * 34 + second - 100;
  return (Number(siren) + 1 + Math.floor(check / 11)) % 11 === check % 11;
}

function validAustrian(body: string): boolean {
  if (body.length !== 9 || body[0] !== 'U' || !DIGITS.test(body.slice(1))) return false;
  const check = (6 - luhnChecksum(body.slice(1, 8)) + 10) % 10;
  return String(check) === body[8];
}

function validBelgian(raw: string): boolean {
  const body = raw.length === 9 ? `0${raw}` : raw;
  if (!DIGITS.test(body) || Number(body) <= 0 || body.length !== 10 || !'01'.includes(body[0] as string)) return false;
  return (Number(body.slice(0, -2)) + Number(body.slice(-2))) % 97 === 0;
}

function validDutchNineDigit(nine: string): boolean {
  if (!DIGITS.test(nine) || Number(nine) <= 0 || nine.length !== 9) return false;
  let total = 0;
  for (let index = 0; index < 8; index += 1) total += (9 - index) * (nine.charCodeAt(index) - 48);
  return (((total - (nine.charCodeAt(8) - 48)) % 11) + 11) % 11 === 0;
}

function validDutch(body: string): boolean {
  const suffix = body.slice(-3);
  const head = body.slice(0, -3).padStart(9, '0');
  const number = head + suffix;
  if (!DIGITS.test(number.slice(0, 9)) || Number(number.slice(0, 9)) <= 0) return false;
  if (!DIGITS.test(number.slice(10)) || Number(number.slice(10)) <= 0) return false;
  if (number.length !== 12 || number[9] !== 'B') return false;
  return validDutchNineDigit(number.slice(0, 9)) || alnumMod97(`NL${number}`) === 1;
}

export function isValidElevenDigitId(raw: string): boolean {
  const normalized = normalizeChecksumId(raw);
  return validItalian(normalized.startsWith('IT') ? normalized.slice(2) : normalized);
}

export function isValidEighteenCharId(raw: string): boolean {
  const normalized = normalizeChecksumId(raw);
  if (normalized.length !== 18 || !DIGITS.test(normalized.slice(0, 8))) return false;
  if ([...normalized.slice(8)].some((character) => !EIGHTEEN_CHAR_ALPHABET.includes(character))) return false;
  let total = 0;
  for (let index = 0; index < 17; index += 1) total += EIGHTEEN_CHAR_ALPHABET.indexOf(normalized[index] as string) * (EIGHTEEN_CHAR_WEIGHTS[index] as number);
  const expected = EIGHTEEN_CHAR_ALPHABET[(((31 - total) % 31) + 31) % 31];
  return normalized[17] === expected;
}

export function isValidCountryPrefixedId(raw: string): boolean {
  const normalized = normalizeChecksumId(raw);
  if (!COUNTRY_PREFIXED_SHAPE.test(normalized)) return false;
  const country = normalized.slice(0, 2);
  const body = normalized.slice(2);
  switch (country) {
    case 'IT':
      return validItalian(body);
    case 'DE':
      return validGerman(body);
    case 'FR':
      return validFrench(body);
    case 'AT':
      return validAustrian(body);
    case 'BE':
      return validBelgian(body);
    case 'NL':
      return validDutch(body);
    default:
      return false;
  }
}

/** Picks the scheme by shape, as the sidecar does, and validates it. */
export function classifyChecksumId(raw: string): ChecksumIdCheck {
  const normalized = normalizeChecksumId(raw);
  if (ELEVEN_DIGIT_SHAPE.test(normalized)) return { scheme: 'it_iva', valid: validItalian(normalized), normalized };
  if (EIGHTEEN_CHAR_SHAPE.test(normalized)) return { scheme: 'cn_uscc', valid: isValidEighteenCharId(normalized), normalized };
  if (COUNTRY_PREFIXED_SHAPE.test(normalized)) return { scheme: 'eu_vat', valid: isValidCountryPrefixedId(normalized), normalized };
  return { scheme: 'unknown', valid: false, normalized };
}
