/**
 * Diagnostics helper: turn an Axios (or generic) error into a full,
 * safe-to-log detail object + a one-line summary.
 *
 * Security: we log the RESPONSE headers (safe) and the request body, but never
 * the REQUEST headers — those carry the Authorization bearer token.
 */
function isAxiosError(err) {
  return !!(err && (err.isAxiosError || err.config || err.response));
}

function formatAxiosError(err, extra = {}) {
  const config = err?.config || {};
  return {
    message: err?.message,
    status: err?.response?.status,
    statusText: err?.response?.statusText,
    response: err?.response?.data,
    responseHeaders: err?.response?.headers,   // response headers only (no secrets)
    requestUrl: config.url,
    method: config.method,
    payload: config.data,                       // request body (no secrets; auth is in headers)
    stack: err?.stack,
    ...extra,
  };
}

/** Compact, single-line summary for console/pm2 logs. */
function summarize(err) {
  const status = err?.response?.status ?? '';
  const statusText = err?.response?.statusText ?? '';
  const method = (err?.config?.method || '').toUpperCase();
  const url = err?.config?.url || '';
  const data = err?.response?.data;
  const body = data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data));
  return `${status} ${statusText} ${method} ${url} — ${body}`.trim();
}

module.exports = { isAxiosError, formatAxiosError, summarize };
