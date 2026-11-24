/**
 * Same-origin fetch helper for Config UI RAG admin panels (admin_session cookie forwarded by config-server).
 */

function resolveMainAppUrl() {
  if (typeof window !== 'undefined' && typeof window.getConfiguredMyRAGAppUrl === 'function') {
    return window.getConfiguredMyRAGAppUrl();
  }
  if (typeof window !== 'undefined' && window.location) {
    return window.location.origin;
  }
  return 'http://localhost:3000';
}

function authMessage(status, appUrl = resolveMainAppUrl()) {
  if (status === 401 || status === 403) {
    return `Admin sign-in required. Sign in to the main myRAG app at ${appUrl} (Settings → Admin tab), then reload the Config UI.`;
  }
  if (status === 503) {
    return 'Service temporarily unavailable. Please retry in a moment.';
  }
  return `Request failed (${status})`;
}

function buildRagFetchInit(apiPath, init = {}) {
  const normalized = apiPath.startsWith('/') ? apiPath : `/api/rag/${apiPath}`;
  const url = normalized.startsWith('/api/rag/') ? normalized : `/api/rag/${normalized.replace(/^\/+/, '')}`;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  delete headers.Authorization;
  return {
    url,
    init: {
      ...init,
      credentials: 'same-origin',
      headers,
    },
  };
}

async function ragFetch(apiPath, init = {}) {
  const { url, init: requestInit } = buildRagFetchInit(apiPath, init);
  const response = await fetch(url, requestInit);
  const status = response.status;
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (status === 401 || status === 403 || status === 503) {
    return { ok: false, status, message: authMessage(status), body };
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && body.error ? String(body.error) : `Request failed (${status})`;
    return { ok: false, status, message, body };
  }
  return { ok: true, status, body };
}

if (typeof window !== 'undefined') {
  window.authMessage = authMessage;
  window.ragFetch = ragFetch;
  window.buildRagFetchInit = buildRagFetchInit;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { authMessage, buildRagFetchInit, ragFetch };
}