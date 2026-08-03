import './style.css';
import { createMap } from './map.js';
import {
  renderGunInfo,
  renderSolution,
  renderPlace,
  setAnswer,
  setStatus,
  refreshConditionsAge
} from './ui.js';
import { describeImpact } from './describe.js';
import { loadShared } from './history.js';

// Live mode just re-pulls the shared JSON. Cron updates at most hourly; the
// 5-min refresh aligns with raw.githubusercontent.com's 5-min CDN cache, so a
// page left open picks up a new tick within five minutes of the cron push.
const REFRESH_MS = 5 * 60 * 1000;

// Pre-rendered storm replays — see scripts/precompute-storm.mjs. The browser
// only fetches; nothing is recomputed here, so js-ballistics WASM never loads.
const KNOWN_STORMS = {
  eowyn: { url: 'storms/eowyn.json', label: 'Storm Éowyn · 24 Jan 2025' }
};

const { showSolution, showHistory } = createMap('map');
renderGunInfo();

const params = new URLSearchParams(location.search);

let history = [];
let showGhosts = params.get('ghosts') === '1';

const stormKey = params.has('storm') ? params.get('storm') || 'eowyn' : null;
const storm = stormKey ? KNOWN_STORMS[stormKey] ?? KNOWN_STORMS.eowyn : null;
const inStormMode = Boolean(storm);

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
    document.getElementById('ans-sub').textContent =
      'No recent forecast yet — try again in a few minutes.';
  }
  setStatus('');
}

if (!inStormMode) {
  document.getElementById('refresh-btn')?.addEventListener('click', () => refresh());
}

async function runStorm() {
  // Storm replays are pre-rendered into static JSON files; just fetch + render.
  setStatus('loading historical…');
  const btn = document.getElementById('refresh-btn');
  if (btn) {
    btn.textContent = '← back to live';
    btn.title = 'Return to live weather';
    btn.onclick = () => {
      location.href = location.pathname;
    };
  }
  try {
    const base = import.meta.env?.BASE_URL ?? '/';
    const res = await fetch(`${base}${storm.url}`);
    if (!res.ok) throw new Error(`storm fetch HTTP ${res.status}`);
    const result = await res.json();
    render(result);
    await describe(result);
  } catch (err) {
    console.error('Storm replay failed:', err);
    document.getElementById('ans-sub').textContent = 'Failed to load historical replay.';
  }
  setStatus(storm.label);
}

async function runLive() {
  await refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(refreshConditionsAge, 20000); // tick the "checked … ago" text
  window.addEventListener('focus', () => refresh()); // re-pull when the user returns to the tab
}

if (inStormMode) runStorm();
else runLive();
