'use strict';

/**
 * Serializes one value for a KEY=value line of .env.local so that dotenv (the Config UI's reader and Next.js) reads it back
 * unchanged (06.1 W1). A value dotenv already reads back as written stays unquoted, byte for byte. Otherwise: double quotes with
 * \n and \r escapes when the value holds no double quote or backslash; single quotes (literal) when it holds no single quote and
 * no line break; backticks (literal) when it holds no backtick and no carriage return. Anything else cannot be written losslessly
 * and throws, so a save never silently changes a value.
 */
function formatEnvValue(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (text === '') return '';
  const plain = !/[\r\n#]/.test(text) && text.trim() === text && !/^['"`]/.test(text);
  if (plain) return text;
  if (!/["\\]/.test(text)) return `"${text.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
  if (!/['\r\n]/.test(text)) return `'${text}'`;
  if (!/[`\r]/.test(text)) return `\`${text}\``;
  throw new Error('[Config] value cannot be written to .env.local without changing it');
}

module.exports = { formatEnvValue };
