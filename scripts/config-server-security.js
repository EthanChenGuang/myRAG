const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_HEADER = 'x-config-ui';

const SECRET_NAME =
  /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|SERVICE_ROLE|DATABASE_URL|WEBHOOK|DSN|CREDENTIAL|COOKIE|SALT|CERT|CONNECTION_STRING|JWT|SIGNING)/i;
const BENIGN_NAME = /(_TOKENS$|TOKEN_TTL|TOKEN_LIMIT|KEY_TERMS)/;
const SECRET_VALUE_NAMES = new Set(['MCP_CUSTOM_SERVERS']);
const SECRET_VALUE_PATTERN = /^MCP_[A-Z0-9_]*_ENDPOINT$/;
const URL_WITH_CREDENTIALS = /:\/\/[^/\s:@]+:[^/\s@]*@/;

const ALLOWED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'ico'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const KIND_EXTENSION = { png: 'png', jpeg: 'jpg', webp: 'webp', ico: 'ico' };
const EXTENSION_KIND = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', ico: 'ico' };

function parseHostHeader(value) {
  const match = /^(\[[0-9a-f:]+\]|[^:/\s]+)(?::(\d+))?$/i.exec(String(value || '').trim());
  if (!match) return null;
  return { hostname: match[1].toLowerCase(), port: match[2] ? Number(match[2]) : 80 };
}

function isAllowedHost(hostHeader, localPort) {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed) return false;
  return LOOPBACK_HOSTS.has(parsed.hostname) && parsed.port === localPort;
}

function isSameOrigin(req, value) {
  if (!value) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && isAllowedHost(parsed.host, req.socket.localPort) && parsed.host.toLowerCase() === String(req.headers.host).toLowerCase();
}

/**
 * First middleware of the config server. It answers 403 to any request whose Host is not this tool on loopback
 * (DNS rebinding), and to any state-changing request that is not same-origin and does not carry the UI's custom header
 * (cross-site form posts cannot set the header, and fetch with it needs a preflight that is never answered).
 */
function securityMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  if (!isAllowedHost(req.headers.host, req.socket.localPort)) {
    return res.status(403).json({ error: 'Forbidden host' });
  }

  if (req.method === 'OPTIONS') {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }

  if (MUTATING_METHODS.has(req.method)) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const sameOrigin = origin ? isSameOrigin(req, origin) : isSameOrigin(req, referer);
    if (!sameOrigin || req.headers[CSRF_HEADER] !== '1') {
      return res.status(403).json({ error: 'Cross-site request refused' });
    }
  }

  return next();
}

function isSecretConfigEntry(name, value) {
  if (SECRET_VALUE_NAMES.has(name) || SECRET_VALUE_PATTERN.test(name)) return true;
  if (SECRET_NAME.test(name) && !BENIGN_NAME.test(name)) return true;
  return typeof value === 'string' && URL_WITH_CREDENTIALS.test(value);
}

/** Splits an env map into values safe to show and the names of secrets that are set. Secret values never leave the server. */
function maskConfig(config) {
  const visible = {};
  const secretsSet = [];
  for (const [name, value] of Object.entries(config)) {
    if (isSecretConfigEntry(name, value)) {
      if (value !== '') secretsSet.push(name);
    } else {
      visible[name] = value;
    }
  }
  return { config: visible, secretsSet };
}

function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function sniffImageKind(bytes) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'ico';
  return null;
}

/** Same rules as src/lib/image-upload.ts: raster images only, name and leading bytes must agree, no SVG or HTML. */
function validateImageUpload(fileName, bytes) {
  const name = String(fileName || '');
  const claimed = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(claimed)) {
    return { ok: false, error: 'Only PNG, JPG, WEBP and ICO files are allowed' };
  }
  if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Image must be between 1 byte and 5 MB' };
  }
  const kind = sniffImageKind(bytes);
  if (!kind || EXTENSION_KIND[claimed] !== kind) {
    return { ok: false, error: 'File content does not match an allowed image type' };
  }
  return { ok: true, extension: KIND_EXTENSION[kind] };
}

const LOGO_TYPES = new Set(['header', 'ai']);

/** Value text that is safe to write on one .env.local line, or null when it cannot be. Real newlines become the literal \n the RAG prompt readers expect. */
function toEnvLineValue(value) {
  const text = String(value);
  if (/[\r\0\u2028\u2029]/.test(text)) return null;
  return text.replace(/\n/g, '\\n');
}

function hasEnvLineBreak(value) {
  return /[\r\n\0\u2028\u2029]/.test(String(value));
}

module.exports = {
  CSRF_HEADER,
  LOGO_TYPES,
  MAX_IMAGE_BYTES,
  hasEnvLineBreak,
  isAllowedHost,
  isSecretConfigEntry,
  maskConfig,
  securityMiddleware,
  sniffImageKind,
  toEnvLineValue,
  validateImageUpload,
};
