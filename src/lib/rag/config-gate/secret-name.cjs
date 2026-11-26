'use strict';

// Phase 5.3 O-3 item 5: the one secret-name rule, shared by scripts/config-server-security.js
// and src/lib/config-env-allowlist.ts. Lives under src/ because .vercelignore drops scripts/.

const SECRET_NAME_SOURCE =
  '(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|SERVICE_ROLE|DATABASE_URL|WEBHOOK|DSN|CREDENTIAL|COOKIE|SALT|CERT|CONNECTION_STRING|JWT|SIGNING)';
const BENIGN_NAME_SOURCE = '(_TOKENS$|TOKEN_TTL|TOKEN_LIMIT|TOKEN_BUDGET|KEY_TERMS)';
const SECRET_NAME = new RegExp(SECRET_NAME_SOURCE, 'i');
const BENIGN_NAME = new RegExp(BENIGN_NAME_SOURCE);
const SECRET_VALUE_NAMES = new Set(['MCP_CUSTOM_SERVERS', 'REDIS_URL']);
const SECRET_VALUE_PATTERN = /^MCP_[A-Z0-9_]*_ENDPOINT$/;
const URL_WITH_CREDENTIALS = /:\/\/[^/\s:@]+:[^/\s@]*@/;

function isSecretName(name) {
  if (typeof name !== 'string') return false;
  if (SECRET_VALUE_NAMES.has(name) || SECRET_VALUE_PATTERN.test(name)) return true;
  return SECRET_NAME.test(name) && !BENIGN_NAME.test(name);
}

function hasUrlCredentials(value) {
  return typeof value === 'string' && URL_WITH_CREDENTIALS.test(value);
}

module.exports = { SECRET_NAME_SOURCE, BENIGN_NAME_SOURCE, URL_WITH_CREDENTIALS, isSecretName, hasUrlCredentials };
