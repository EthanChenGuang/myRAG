'use strict';

const SECRET_NAME_SOURCE = '';
const BENIGN_NAME_SOURCE = '';
const URL_WITH_CREDENTIALS = /:\/\/[^/\s:@]+:[^/\s@]*@/;

function isSecretName() {
  return false;
}

function hasUrlCredentials() {
  return false;
}

module.exports = { SECRET_NAME_SOURCE, BENIGN_NAME_SOURCE, URL_WITH_CREDENTIALS, isSecretName, hasUrlCredentials };
