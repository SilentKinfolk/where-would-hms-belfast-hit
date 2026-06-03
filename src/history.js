// Persistent log of past fall-of-shot estimates (localStorage), so the "ghost"
// trail builds up across refreshes and page reloads. Compact entries only —
// enough to re-plot without recomputing.

// Bump the key for a clean start; superseded keys are removed on load.
// v2: started saving the dispersion ellipse. v3: fresh start after the live
// trajectory became the real curved track.
const KEY = 'belfast-impact-history-v3';
const OLD_KEYS = ['belfast-impact-history', 'belfast-impact-history-v2'];
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 days
const MIN_GAP_MS = 60 * 1000; // don't log two points within a minute

/** Load history (newest last), dropping anything malformed or too old. */
export function loadHistory() {
  try {
    OLD_KEYS.forEach((k) => localStorage.removeItem(k)); // tidy up superseded data
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return arr.filter(
      (e) => e && typeof e.lat === 'number' && typeof e.lon === 'number' && e.t > cutoff
    );
  } catch {
    return [];
  }
}

/** Append an impact result (only meaningful for live-weather computes). */
export function recordImpact(result) {
  const hist = loadHistory();
  const last = hist[hist.length - 1];
  if (last && result.computedAt - last.t < MIN_GAP_MS) return hist;

  hist.push({
    t: result.computedAt,
    lat: result.impact.lat,
    lon: result.impact.lon,
    missM: Math.round(result.missM),
    cepM: Math.round(result.cepM),
    deflectionM: Math.round(result.deflectionM),
    rangeErrorM: Math.round(result.rangeErrorM),
    // Save the actual 50% dispersion ellipse (the oblong), not just the CEP circle.
    ellipse: result.ellipse
      ? {
          semiMajorM: Math.round(result.ellipse.semiMajorM),
          semiMinorM: Math.round(result.ellipse.semiMinorM),
          orientationDeg: Math.round(result.ellipse.orientationDeg)
        }
      : null,
    wind: result.conditions
      ? {
          speedMs: Number(result.conditions.windAloft.speedMs.toFixed(1)),
          dirDeg: Math.round(result.conditions.windAloft.dirDeg)
        }
      : null
  });

  const trimmed = hist.slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* storage full / unavailable — keep going in-memory */
  }
  return trimmed;
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return [];
}
