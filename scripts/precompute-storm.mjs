// Pre-compute historical storm replays so the browser doesn't run the engine
// for them. Run once, commit the output; re-run if the engine, drag model, or
// the BELFAST/TARGET constants change.
//
//   node scripts/precompute-storm.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { fetchHistoricalWeather, fetchElevations } from '../src/weather.js';
import { computeImpact } from '../src/ballistics/index.js';
import { BELFAST, TARGET } from '../src/data/belfast.js';
import { enrichImpact } from './enrich-impact.mjs';

// To add a storm: drop a new {key, date, hour?, label} here and re-run.
const STORMS = [
  { key: 'eowyn', date: '2025-01-24', hour: null, label: 'Storm Éowyn · 24 Jan 2025' }
];

const OUT_DIR = fileURLToPath(new URL('../public/storms/', import.meta.url));

async function precompute(storm) {
  const [weather, elevs] = await Promise.all([
    fetchHistoricalWeather(
      BELFAST.position.lat,
      BELFAST.position.lon,
      storm.date,
      storm.hour ?? undefined
    ),
    fetchElevations([BELFAST.position, TARGET.position]).catch(() => null)
  ]);
  const geometry = elevs ? { gunGroundElevM: elevs[0], targetGroundElevM: elevs[1] } : null;

  const result = await computeImpact({ weather, geometry });

  // Pin the wall-clock fields to the storm's obsTime so the file is byte-stable
  // across re-runs (only changes if the engine output actually changes).
  const obsMs = Date.parse(result.conditions.obsTime + 'Z');
  result.computedAt = obsMs;
  if (result.conditions) result.conditions.fetchedAt = obsMs;

  await enrichImpact(result);

  await mkdir(OUT_DIR, { recursive: true });
  const path = OUT_DIR + storm.key + '.json';
  await writeFile(path, JSON.stringify(result, null, 2) + '\n');

  const w = result.conditions.windAloft;
  console.log(
    `Wrote ${storm.key}.json: ${storm.label} — miss ${Math.round(result.missM)} m,` +
      ` CEP ${Math.round(result.cepM)} m, wind aloft ${w.speedMs.toFixed(1)} m/s from ${Math.round(w.dirDeg)}°`
  );
}

for (const s of STORMS) await precompute(s);
