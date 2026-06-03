// Append a single live-weather impact estimate to public/impacts.json.
// Run by .github/workflows/log-impact.yml on a cron; uses the same engine and
// data sources as the browser, so the shared ghost trail looks identical to
// what a visitor's localStorage used to accumulate.
//
// Local dry-run:   node scripts/log-impact.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { fetchWeather, fetchTide, fetchElevations } from '../src/weather.js';
import { computeImpact } from '../src/ballistics/index.js';
import { BELFAST, TARGET } from '../src/data/belfast.js';

const IMPACTS_PATH = fileURLToPath(new URL('../public/impacts.json', import.meta.url));

const MAX_ENTRIES = 1500; // ~30 days at 30-min cadence (1440 max), with slack
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MIN_GAP_MS = 60 * 1000; // dedup if two runs land within a minute

// Same compact shape src/history.js used in localStorage — just enough to redraw.
function buildEntry(result) {
  return {
    t: result.computedAt,
    lat: result.impact.lat,
    lon: result.impact.lon,
    missM: Math.round(result.missM),
    cepM: Math.round(result.cepM),
    deflectionM: Math.round(result.deflectionM),
    rangeErrorM: Math.round(result.rangeErrorM),
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
  };
}

async function loadExisting() {
  try {
    const raw = await readFile(IMPACTS_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Write the JSON array one entry per line — keeps each tick a clean, reviewable
// one-line addition in `git diff` while still being valid JSON.
function serialise(entries) {
  if (entries.length === 0) return '[]\n';
  return '[\n' + entries.map((e) => JSON.stringify(e)).join(',\n') + '\n]\n';
}

async function main() {
  const [weather, tide, elevs] = await Promise.all([
    fetchWeather(BELFAST.position.lat, BELFAST.position.lon),
    fetchTide().catch(() => null),
    fetchElevations([BELFAST.position, TARGET.position]).catch(() => null)
  ]);
  const geometry = elevs ? { gunGroundElevM: elevs[0], targetGroundElevM: elevs[1] } : null;

  const result = await computeImpact({ weather, tide, geometry });
  if (!result.conditions) {
    throw new Error('No live conditions in result — refusing to log (would corrupt the shared trail).');
  }
  const entry = buildEntry(result);

  const existing = await loadExisting();
  const last = existing[existing.length - 1];
  if (last && entry.t - last.t < MIN_GAP_MS) {
    console.log(`Skipping: last entry is ${Math.round((entry.t - last.t) / 1000)}s old (<${MIN_GAP_MS / 1000}s).`);
    return;
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const next = existing.filter((e) => e && typeof e.lat === 'number' && typeof e.t === 'number' && e.t > cutoff);
  next.push(entry);
  if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);

  await writeFile(IMPACTS_PATH, serialise(next));

  const w = entry.wind;
  console.log(
    `Logged: ${entry.lat.toFixed(5)}, ${entry.lon.toFixed(5)} · miss ${entry.missM} m · CEP ${entry.cepM} m` +
      (w ? ` · wind aloft ${w.speedMs} m/s from ${w.dirDeg}°` : '') +
      ` · ${next.length}/${MAX_ENTRIES} entries`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
