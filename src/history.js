// Shared ghost trail of past fall-of-shot estimates. The canonical log lives
// in public/impacts.json, refreshed every 30 min by .github/workflows/log-impact.yml
// (cron) and shipped with the static site. Every visitor sees the same trail.
//
// Previously this was a per-browser localStorage log; that's been retired so
// the trail is consistent across users.

const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // mirror what the cron trims to

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
  // Vite's BASE_URL handles the GitHub Pages sub-path; cache-buster forces a
  // fresh fetch every clock minute so the CDN doesn't serve stale entries.
  const base = import.meta.env?.BASE_URL ?? '/';
  const url = `${base}impacts.json?t=${Math.floor(Date.now() / 60000)}`;
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
