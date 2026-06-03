// Pre-render the live answer + ghost trail server-side.
//
// Run by .github/workflows/log-impact.yml every 30 min. Writes public/impacts.json
// as { latest, history }: `latest` is the full ImpactResult the site renders
// verbatim (no in-browser compute on the critical path); `history` is the
// compact ghost trail. On each tick the previous `latest` is demoted into
// `history`, then a new `latest` is computed.
//
// Local dry-run:   node scripts/log-impact.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  fetchWeather,
  fetchTide,
  fetchElevations,
  fetchEnsembleUncertainty
} from '../src/weather.js';
import { computeImpact } from '../src/ballistics/index.js';
import { BELFAST, TARGET } from '../src/data/belfast.js';
import { loadDem, elevationAt } from '../src/dem.js';
import { enrichImpact, renderOgImageForResult } from './enrich-impact.mjs';

const IMPACTS_PATH = fileURLToPath(new URL('../public/impacts.json', import.meta.url));

const MAX_ENTRIES = 1500; // ~30 days at 30-min cadence (1440), with slack
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MIN_GAP_MS = 60 * 1000; // dedup if two runs land within a minute

// Compact form for the ghost trail — enough to redraw the point + ellipse,
// plus the Nominatim place label and the Claude one-liner that ran with that
// tick. The ghost popup doesn't read those two; they live in the JSON purely
// as a record of what each past run said when it happened.
function compactEntry(result) {
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
      : null,
    place: result.place ?? null,
    description: result.description ?? null
  };
}

async function loadExisting() {
  try {
    const raw = await readFile(IMPACTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Legacy: file was a bare array of compact entries before this refactor.
    if (Array.isArray(parsed)) return { latest: null, history: parsed };
    if (parsed && typeof parsed === 'object') {
      return {
        latest: parsed.latest ?? null,
        history: Array.isArray(parsed.history) ? parsed.history : []
      };
    }
    return { latest: null, history: [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { latest: null, history: [] };
    throw err;
  }
}

// `latest` on one big line, history one entry per line — clean diffs per tick.
function serialise({ latest, history }) {
  const head = `  "latest": ${latest ? JSON.stringify(latest) : 'null'}`;
  const hist =
    history.length === 0
      ? '  "history": []'
      : '  "history": [\n' +
        history.map((e) => '    ' + JSON.stringify(e)).join(',\n') +
        '\n  ]';
  return `{\n${head},\n${hist}\n}\n`;
}

async function main() {
  const [weather, tide, elevs, ensembleSigmas, dem] = await Promise.all([
    fetchWeather(BELFAST.position.lat, BELFAST.position.lon),
    fetchTide().catch(() => null),
    fetchElevations([BELFAST.position, TARGET.position]).catch(() => null),
    fetchEnsembleUncertainty(BELFAST.position.lat, BELFAST.position.lon).catch(() => null),
    loadDem().catch(() => null)
  ]);
  const geometry = elevs ? { gunGroundElevM: elevs[0], targetGroundElevM: elevs[1] } : null;
  const groundElevAt = dem ? (lat, lon) => elevationAt(dem, lat, lon) : null;

  const result = await computeImpact({
    weather,
    tide,
    geometry,
    ensembleSigmas,
    groundElevAt,
    demSource: dem?.source ?? null
  });
  if (!result.conditions) {
    throw new Error('No live conditions in result — refusing to log.');
  }

  // Load existing first so enrichImpact() can reuse the prior tick's AI line
  // when the new impact has barely moved (saves a Claude call).
  const existing = await loadExisting();
  await enrichImpact(result, existing.latest);
  await renderOgImageForResult(result);

  // Don't double-log if the previous tick is too fresh (safety against rapid manual triggers).
  if (
    existing.latest &&
    result.computedAt - existing.latest.computedAt < MIN_GAP_MS
  ) {
    const ageS = Math.round((result.computedAt - existing.latest.computedAt) / 1000);
    console.log(`Skipping: previous latest is ${ageS}s old (<${MIN_GAP_MS / 1000}s).`);
    return;
  }

  // Demote the previous latest into the ghost trail; the new compute takes its place.
  let history = Array.isArray(existing.history) ? existing.history.slice() : [];
  if (existing.latest) {
    history.push(compactEntry(existing.latest));
  }

  // Trim by age + count.
  const cutoff = Date.now() - MAX_AGE_MS;
  history = history.filter(
    (e) => e && typeof e.lat === 'number' && typeof e.t === 'number' && e.t > cutoff
  );
  if (history.length > MAX_ENTRIES) history = history.slice(history.length - MAX_ENTRIES);

  await writeFile(IMPACTS_PATH, serialise({ latest: result, history }));

  const w = result.conditions.windAloft;
  console.log(
    `Logged: ${result.impact.lat.toFixed(5)}, ${result.impact.lon.toFixed(5)}` +
      ` · miss ${Math.round(result.missM)} m · CEP ${Math.round(result.cepM)} m` +
      ` · wind aloft ${w.speedMs.toFixed(1)} m/s from ${Math.round(w.dirDeg)}°` +
      ` · history ${history.length}/${MAX_ENTRIES}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
