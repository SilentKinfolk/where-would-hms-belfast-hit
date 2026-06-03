import './style.css';
import { createMap } from './map.js';
import { computeImpact } from './ballistics/index.js';
import {
  renderGunInfo,
  renderSolution,
  renderPlace,
  setAnswer,
  setStatus,
  refreshConditionsAge
} from './ui.js';
import { fetchElevations, fetchHistoricalWeather } from './weather.js';
import { describeImpact } from './describe.js';
import { loadShared } from './history.js';
import { BELFAST, TARGET } from './data/belfast.js';

// Live mode just re-pulls the shared JSON. Cron updates at most every 30 min;
// 5-min refresh aligns with raw.githubusercontent.com's 5-min CDN cache.
const REFRESH_MS = 5 * 60 * 1000;

const { showSolution, showHistory } = createMap('map');
renderGunInfo();

const params = new URLSearchParams(location.search);

let history = [];
let showGhosts = params.get('ghosts') === '1';

// Hidden "replay a past day" mode. `?storm` replays the Storm Éowyn case;
// `?date=YYYY-MM-DD&hour=H` replays any day winds-aloft history covers (~late 2024+).
const STORMS = { eowyn: { date: '2025-01-24', hour: null, label: 'Storm Éowyn · 24 Jan 2025' } };
let replay = null;
if (params.has('storm')) replay = STORMS[params.get('storm') || 'eowyn'] ?? STORMS.eowyn;
else if (params.get('date')) {
  const h = params.get('hour');
  replay = { date: params.get('date'), hour: h != null ? Number(h) : null, label: params.get('date') };
}
const historical = Boolean(replay);

const ghostsBtn = document.getElementById('ghosts-btn');

function updateGhosts() {
  if (ghostsBtn) {
    ghostsBtn.textContent = `${showGhosts ? 'hide' : 'show'} past calculations (${history.length})`;
    ghostsBtn.setAttribute('aria-pressed', String(showGhosts));
  }
  showHistory(history, showGhosts);
}

ghostsBtn?.addEventListener('click', () => {
  showGhosts = !showGhosts;
  updateGhosts();
});
updateGhosts(); // initial label (count: 0) — replaced once the shared data loads

// "How does this work?" toggles the explainer prose in the hero.
const howBtn = document.getElementById('how-btn');
const howProse = document.getElementById('how-prose');
howBtn?.addEventListener('click', () => {
  const opening = howProse.hasAttribute('hidden');
  howProse.toggleAttribute('hidden', !opening);
  howBtn.setAttribute('aria-expanded', String(opening));
});

// "Replay Storm Éowyn" — enters the hidden historical mode via the URL.
document.getElementById('storm-btn')?.addEventListener('click', () => {
  location.assign('?storm');
});

function render(result) {
  showSolution(result);
  renderSolution(result);
}

// Set the headline. Prefer the cron-pre-rendered place/description if present;
// otherwise fall back to a client-side Nominatim lookup. (When the AI describer
// is wired into the cron, `description` will be the Claude vision one-liner.)
async function describe(result) {
  if (result.place) {
    renderPlace(result.place, result);
  } else {
    try {
      renderPlace(await describeImpact(result.impact.lat, result.impact.lon), result);
    } catch {
      renderPlace(null, result);
    }
  }
  if (result.description) {
    setAnswer(result.description);
  }
}

// Live mode: re-fetch the shared JSON and re-render. Cheap — no WASM, no
// Open-Meteo, no tide / elevation fetches on the visit critical path.
async function refresh() {
  setStatus('updating…');
  const { latest, history: hist } = await loadShared();
  history = hist;
  updateGhosts();
  if (latest) {
    render(latest);
    await describe(latest);
  } else {
    document.getElementById('ans-sub').textContent = 'No recent forecast yet — try again in a few minutes.';
  }
  setStatus('');
}

if (!historical) {
  document.getElementById('refresh-btn')?.addEventListener('click', () => refresh());
}

async function runHistorical() {
  // `?storm` / `?date` — ad-hoc replay, runs the engine in-browser. The
  // shared JSON isn't involved; nothing is logged.
  setStatus('loading historical…');
  const btn = document.getElementById('refresh-btn');
  if (btn) {
    btn.textContent = '← back to live';
    btn.title = 'Return to live weather';
    btn.onclick = () => {
      location.href = location.pathname;
    };
  }

  const elevs = await fetchElevations([BELFAST.position, TARGET.position]).catch(() => null);
  const geometry = elevs ? { gunGroundElevM: elevs[0], targetGroundElevM: elevs[1] } : null;

  let weather = null;
  try {
    weather = await fetchHistoricalWeather(
      BELFAST.position.lat,
      BELFAST.position.lon,
      replay.date,
      replay.hour ?? undefined
    );
  } catch (err) {
    console.error('Historical fetch failed:', err);
  }
  if (!weather) {
    document.getElementById('ans-sub').textContent =
      `No winds-aloft data for ${replay.date} (history reaches back to ~late 2024).`;
  }

  try {
    const result = await computeImpact({ weather, geometry });
    render(result);
    await describe(result);
  } catch (err) {
    console.error('Ballistics computation failed:', err);
    document.getElementById('solution-note').textContent = 'Computation failed — see console.';
  }
  setStatus(replay.label);
}

async function runLive() {
  await refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(refreshConditionsAge, 20000); // tick the "checked … ago" text
  window.addEventListener('focus', () => refresh()); // re-pull when the user returns to the tab
}

if (historical) runHistorical();
else runLive();
