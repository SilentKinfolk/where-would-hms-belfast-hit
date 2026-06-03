// Shared impacts data — both the live answer (`latest`) and the ghost trail
// (`history`). The canonical log lives at public/impacts.json on the main
// branch, refreshed every 30 min by .github/workflows/log-impact.yml; the
// browser fetches it straight from raw.githubusercontent.com in production so
// cron commits don't need a Pages redeploy.
//
// `latest` is the full ImpactResult — the site renders it verbatim, no
// in-browser ballistics on the critical path. `history` is the compact ghost
// trail of previous ticks.

const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

const RAW_URL =
  'https://raw.githubusercontent.com/SilentKinfolk/where-would-hms-belfast-hit/main/public/impacts.json';

// Names from the earlier per-browser localStorage version — tidied on load so
// they don't linger forever.
const RETIRED_LOCAL_KEYS = [
  'belfast-impact-history',
  'belfast-impact-history-v2',
  'belfast-impact-history-v3'
];

function tidyRetiredStorage() {
  try {
    RETIRED_LOCAL_KEYS.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* not a browser, or storage unavailable */
  }
}

function filterHistory(arr) {
  if (!Array.isArray(arr)) return [];
  const cutoff = Date.now() - MAX_AGE_MS;
  return arr.filter(
    (e) =>
      e &&
      typeof e.lat === 'number' &&
      typeof e.lon === 'number' &&
      typeof e.t === 'number' &&
      e.t > cutoff
  );
}

/**
 * Fetch the shared impacts data.
 * @returns {Promise<{latest: object|null, history: object[]}>}
 */
export async function loadShared() {
  tidyRetiredStorage();
  // Dev uses Vite's served copy; prod hits raw directly so updates don't
  // depend on a Pages redeploy. Cache-buster (per clock-minute) forces fresh
  // past raw's 5-min Cache-Control.
  const bust = Math.floor(Date.now() / 60000);
  const url = import.meta.env?.DEV
    ? `${import.meta.env.BASE_URL ?? '/'}impacts.json?t=${bust}`
    : `${RAW_URL}?t=${bust}`;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return { latest: null, history: [] };
    const body = await res.json();
    // Legacy: file was a bare array of compact entries (pre-defer-to-cron).
    if (Array.isArray(body)) return { latest: null, history: filterHistory(body) };
    if (body && typeof body === 'object') {
      return {
        latest: body.latest ?? null,
        history: filterHistory(body.history ?? [])
      };
    }
    return { latest: null, history: [] };
  } catch {
    return { latest: null, history: [] };
  }
}
