'use strict';

const CHECK_TIMEOUT_MS = 0;
const CHILD_ENV_ALLOWLIST = Object.freeze([]);

function createRagGateRunner() {
  return {
    async start() {
      return { status: 501, body: {} };
    },
    get() {
      return null;
    },
    latest() {
      return null;
    },
    async idle() {},
  };
}

function registerRagGateRoutes() {}

module.exports = { CHECK_TIMEOUT_MS, CHILD_ENV_ALLOWLIST, createRagGateRunner, registerRagGateRoutes };
