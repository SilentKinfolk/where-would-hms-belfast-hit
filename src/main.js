import './style.css';
import { createMap } from './map.js';
import { computeImpact } from './ballistics/index.js';
import { renderGunInfo, renderSolution, renderPlace, setAnswer, setStatus, refreshConditionsAge } from './ui.js';
import { fetchWeather, fetchElevations, fetchTide, fetchHistoricalWeather } from './weather.js';
import { describeImpact } from './describe.js';
import { describeImpactAI } from './describe-ai.js';
import { loadHistory, recordImpact } from './history.js';
import { BELFAST, TARGET } from './data/belfast.js';

const REFRESH_MS = 10 * 60 * 1000; // re-pull live weather + tide every 10 minutes

const { showSolution, showHistory } = createMap('map');
renderGunInfo();

const params = new URLSearchParams(location.search);

let geometry = null; // { gunGroundElevM, targetGroundElevM } — fetched once
let history = loadHistory();
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
updateGhosts(); // set the button label + stored count on load

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

// Fill the headline place. Show the reverse-geocoded name immediately (fast),
// then upgrade to the Claude vision one-liner if the /api/describe proxy answers.
async function describe(result) {
  try {
    renderPlace(await describeImpact(result.impact.lat, result.impact.lon), result);
  } catch {
    renderPlace(null, result);
  }
  try {
    setAnswer(await describeImpactAI(result));
  } catch {
    /* proxy unavailable — keep the reverse-geocoded line */
  }
}

async function compute(weather, tide) {
  try {
    const result = await computeImpact({ weather, geometry, tide });
    render(result);
    describe(result);
    // Log only live computes to the ghost trail — not historical replays.
    if (result.conditions && !historical) {
      history = recordImpact(result);
      updateGhosts();
    }
  } catch (err) {
    console.error('Ballistics computation failed:', err);
    document.getElementById('solution-note').textContent =
      'Computation failed — see console.';
  }
}

// Re-pull live weather + tide and recompute (timer + refresh button).
async function refresh() {
  setStatus('updating…');
  const [weather, tide] = await Promise.all([
    fetchWeather(BELFAST.position.lat, BELFAST.position.lon).catch(() => null),
    fetchTide().catch(() => null)
  ]);
  await compute(weather, tide);
  setStatus('');
}

if (!historical) {
  document.getElementById('refresh-btn')?.addEventListener('click', () => refresh());
}

async function run() {
  // Kick off the network immediately, in parallel with the first WASM compute.
  const elevP = fetchElevations([BELFAST.position, TARGET.position]).catch(() => null);
  const weatherP = historical ? null : fetchWeather(BELFAST.position.lat, BELFAST.position.lon).catch(() => null);
  const tideP = historical ? null : fetchTide().catch(() => null);

  // Instant first paint: standard atmosphere, no waiting on the network.
  try {
    const first = await computeImpact({});
    render(first);
    describe(first);
  } catch (err) {
    console.error('Initial computation failed:', err);
  }

  const elevs = await elevP;
  if (elevs) geometry = { gunGroundElevM: elevs[0], targetGroundElevM: elevs[1] };

  if (historical) {
    // Hidden replay mode: one historical day, no live refresh.
    setStatus('loading historical…');
    const btn = document.getElementById('refresh-btn');
    if (btn) {
      btn.textContent = '← back to live';
      btn.title = 'Return to live weather';
      btn.onclick = () => {
        location.href = location.pathname;
      };
    }
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
    await compute(weather, null);
    setStatus(replay.label); // persistent label of which day we're replaying
    return;
  }

  // Live mode
  setStatus('fetching live data…');
  await compute(await weatherP, await tideP);
  setStatus('');
  setInterval(refresh, REFRESH_MS); // re-fetch live weather + tide
  setInterval(refreshConditionsAge, 20000); // tick the "checked … ago" text
}

run();
