// fetch() that survives transient upstream blips. The free APIs we lean on
// (Open-Meteo especially) occasionally reset a connection mid-TLS-handshake
// (ECONNRESET) or 502 under load; a single bare fetch turns that into a dead
// log-impact run. This retries network-level errors and retryable HTTP statuses
// (429 + 5xx) with exponential backoff + jitter, and times out each attempt so
// a hung socket can't stall the run.

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * @param {string} url
 * @param {RequestInit} [init]  passed through to fetch (headers, etc.)
 * @param {{ tries?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<Response>} the final Response — the caller still checks
 *   res.ok. Throws the last error only if every attempt failed at the socket.
 */
export async function fetchRetry(url, init = {}, { tries = 4, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // Success, a non-retryable status, or the final attempt: hand it back and
      // let the caller's own res.ok check produce its usual error message.
      if (attempt >= tries || !RETRY_STATUSES.has(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err; // socket reset / TLS drop / DNS / timeout
      if (attempt >= tries) break;
    }
    await new Promise((r) => setTimeout(r, backoffMs(attempt)));
  }
  throw lastErr;
}

// 300ms, 600ms, 1200ms… capped at 8s, plus up to +25% jitter so several
// callers retrying at once don't march in lockstep.
function backoffMs(attempt) {
  const base = Math.min(8000, 300 * 2 ** (attempt - 1));
  return base + Math.random() * 0.25 * base;
}
