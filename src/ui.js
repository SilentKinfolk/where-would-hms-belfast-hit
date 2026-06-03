// Renders the panel. Pure DOM updates — no map or engine knowledge.

import { GUN, TARGET } from './data/belfast.js';
import { compassName } from './geo.js';

const $ = (id) => document.getElementById(id);

const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
const fmtMiles = (m) => `${(m / 1609.344).toFixed(1)} mi`;
const fmtCoord = (lat, lon) =>
  `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${
    lon >= 0 ? 'E' : 'W'
  }`;
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : fmtKm(m));
const fmtWind = (speedMs, dirDeg) =>
  `${speedMs.toFixed(1)} m/s from ${Math.round(dirDeg)}° ${compassName(dirDeg)}`;
const fmtTide = (m) => `${m >= 0 ? '+' : ''}${m.toFixed(2)} m`;

function agoText(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}

// Kept so the headline conditions line + "checked … ago" can tick on their own.
let lastConditions = null;
let lastTide = null;

const condMetaText = (c) =>
  c.historical
    ? `${c.source} · ${c.obsTime.replace('T', ' ')} GMT · historical replay`
    : `${c.source} · obs ${new Date(`${c.obsTime}Z`).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })} · checked ${agoText(c.fetchedAt)}`;

function condLineText() {
  if (!lastConditions) return 'standard atmosphere — no live weather';
  const c = lastConditions;
  const parts = [
    `${Math.round(c.tempC)} °C`,
    `${c.surfaceWind.speedMs.toFixed(0)} m/s from ${Math.round(c.surfaceWind.dirDeg)}°`
  ];
  if (lastTide) parts.push(`tide ${fmtTide(lastTide.levelMAOD)}`);
  parts.push(c.historical ? `${c.obsTime.replace('T', ' ')} GMT · historical` : `checked ${agoText(c.fetchedAt)}`);
  return parts.join(' · ');
}

const updateCondLine = () => {
  $('ans-cond-text').textContent = condLineText();
};

/** Fill in the static gun specs (run once at startup). */
export function renderGunInfo() {
  $('gun-type').textContent = GUN.designation;
  $('gun-shell').textContent = `${GUN.shellMassLb} lb (${GUN.shellMassKg} kg)`;
  $('gun-mv').textContent = `${GUN.muzzleVelocityMs} m/s`;
  $('gun-range').textContent = `${fmtKm(GUN.maxRangeM)} (max)`;
}

/** Headline sub-line: distance from the target, with the breakdown. */
function missSummary(r) {
  if (r.missM < 50) return `Dead on ${TARGET.name}.`;
  const lr = r.deflectionM >= 0 ? 'right' : 'left';
  const os = r.rangeErrorM >= 0 ? 'over' : 'short';
  return `≈ ${fmtDist(r.missM)} from ${TARGET.name} — ${Math.abs(
    Math.round(r.deflectionM)
  )} m ${lr}, ${Math.abs(Math.round(r.rangeErrorM))} m ${os}.`;
}

/** Set the big headline answer to an explicit line (e.g. the AI vision describer). */
export function setAnswer(text) {
  if (text) $('ans-place').textContent = text;
}

/** Set the big headline place (from reverse geocoding); call after compute. */
export function renderPlace(desc, result) {
  const el = $('ans-place');
  if (desc && desc.place) {
    el.textContent = desc.locality ? `${desc.place}, ${desc.locality}` : desc.place;
  } else if (result) {
    el.textContent = `open ground (${fmtCoord(result.impact.lat, result.impact.lon)})`;
  } else {
    el.textContent = '—';
  }
}

/** Update the whole panel from an ImpactResult. */
export function renderSolution(result) {
  lastTide = result.tide;

  // Headline
  $('ans-sub').textContent = missSummary(result);

  // Gun laying
  $('stat-target').textContent = TARGET.name;
  $('stat-bearing').textContent = `${result.bearingDeg.toFixed(0)}° ${compassName(
    result.bearingDeg
  )}`;
  $('stat-elevation').textContent =
    result.elevationDeg == null ? '—' : `${result.elevationDeg.toFixed(1)}°`;
  $('laying-note').textContent = result.layingAssumed
    ? 'Working assumption (to be confirmed from the ship in person): bearing is the true bearing to the target; elevation is the laying that lands the shell on it.'
    : 'Confirmed gun laying.';

  // Fall of shot
  $('stat-impact').textContent = fmtCoord(result.impact.lat, result.impact.lon);
  $('stat-range').textContent = `${fmtKm(result.rangeM)} · ${fmtMiles(result.rangeM)}`;
  $('stat-miss').textContent =
    result.missM < 50 ? 'on target' : `${fmtDist(result.missM)} from target`;
  $('stat-tof').textContent = `${result.tofS.toFixed(1)} s`;
  $('stat-apex').textContent = Number.isFinite(result.apexM) ? fmtKm(result.apexM) : '—';
  $('stat-vimpact').textContent = `${Math.round(result.impactVelMs)} m/s`;
  $('stat-descent').textContent = `${result.descentDeg.toFixed(1)}°`;
  $('stat-rangepe').textContent =
    result.rangePEm != null ? `± ${Math.round(result.rangePEm)} m` : '—';
  $('stat-deflpe').textContent =
    result.deflectionPEm != null ? `± ${Math.round(result.deflectionPEm)} m` : '—';
  $('stat-cep').textContent =
    result.cepM > 0 ? `${Math.round(result.cepM)} m` : 'not yet modelled';
  $('cep-note').textContent =
    result.cepMetM > 0
      ? `Gun dispersion ${Math.round(result.cepGunM)} m, widened to ${Math.round(
          result.cepM
        )} m by forecast uncertainty (±${Math.round(result.cepMetM)} m).`
      : 'CEP is gun dispersion only (no live-weather uncertainty).';
  $('solution-note').textContent = result.note;

  // Tide row + conditions
  $('cond-tide').textContent = result.tide
    ? `${fmtTide(result.tide.levelMAOD)} AOD · ${result.tide.station}`
    : '—';
  renderConditions(result.conditions);
}

/** Update the live-conditions panel and the headline conditions line. */
export function renderConditions(c) {
  if (!c) {
    lastConditions = null;
    ['cond-temp', 'cond-pressure', 'cond-humidity', 'cond-surfwind', 'cond-aloft'].forEach(
      (id) => ($(id).textContent = '—')
    );
    $('cond-meta').textContent = 'Live weather unavailable — using ICAO standard atmosphere.';
    updateCondLine();
    return;
  }
  lastConditions = c;
  $('cond-temp').textContent = `${c.tempC.toFixed(1)} °C`;
  $('cond-pressure').textContent = `${Math.round(c.pressureHpa)} hPa`;
  $('cond-humidity').textContent = `${Math.round(c.humidity * 100)} %`;
  $('cond-surfwind').textContent = fmtWind(c.surfaceWind.speedMs, c.surfaceWind.dirDeg);
  $('cond-aloft').textContent = `${fmtWind(c.windAloft.speedMs, c.windAloft.dirDeg)} @ ${fmtKm(
    c.windAloft.altitudeM
  )}`;
  $('cond-meta').textContent = condMetaText(c);
  updateCondLine();
}

/** Re-render the "checked … ago" parts so they tick between refreshes. */
export function refreshConditionsAge() {
  if (lastConditions) $('cond-meta').textContent = condMetaText(lastConditions);
  updateCondLine();
}

/** Transient status text in the headline (e.g. "updating…"). */
export function setStatus(text) {
  const el = $('status');
  if (el) el.textContent = text ?? '';
}
