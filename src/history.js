// Shared ghost trail of past fall-of-shot estimates. The canonical log lives
// at public/impacts.json on the main branch, refreshed every 30 min by the
// log-impact cron. The browser fetches it straight from raw.githubusercontent.com
// in production so cron commits don't need a Pages redeploy.
//
// Previously this was a per-browser localStorage log; that's been retired so
// the trail is consistent across users.

const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // mirror what the cron trims to

const RAW_URL =
  'https://raw.githubusercontent.com/SilentKinfolk/where-would-hms-belfast-hit/main/public/impacts.json';

// Names from the earlier per-browser version — tidied on load so they don't
// linger in users' localStorage forever.
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

/** Fetch the shared trail. Newest last. Stale + malformed entries filtered out. */
export async function loadHistory() {
  tidyRetiredStorage();
  // Dev uses Vite's served copy; prod hits the raw URL directly so updates
  // don't depend on Pages redeploying. Cache-buster (per clock-minute) forces
  // a revalidation past raw's 5-min Cache-Control.
  const bust = Math.floor(Date.now() / 60000);
  const url = import.meta.env?.DEV
    ? `${import.meta.env.BASE_URL ?? '/'}impacts.json?t=${bust}`
    : `${RAW_URL}?t=${bust}`;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return [];
    const arr = await res.json();
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
  } catch {
    return [];
  }
}
