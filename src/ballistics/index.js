// Ballistics engine — public interface.
//
// "As it sits" model: the guns hold a FIXED laying (bearing + elevation). We
// fire that laying through the current conditions and report where the shell
// actually falls. Weather changes the fall of shot, NOT the laying — so the
// impact drifts off the target.
//
// Phase 2 feeds live weather in via `computeImpact({ weather, geometry })`.
// Earth curvature + target elevation are modelled as the impact's ground height
// relative to the muzzle; Coriolis is always on. The map/UI only see the result.

import { BELFAST, TARGET, GUN, LAYING, FORECAST_UNCERTAINTY } from '../data/belfast.js';
import { distanceMeters, bearingDeg, destinationPoint } from '../geo.js';
import {
  fireAtElevation,
  computeDispersion,
  trajectoryProfile,
  makeAtmo,
  makeWindLayers
} from './engine.js';
import { cepFromSigmas, PE_PER_SIGMA, ELLIPSE_50_PER_SIGMA } from './dispersion.js';
import { windAtAltitude } from '../weather.js';

const EARTH_RADIUS_M = 6371008.8;

/**
 * Ground height of the impact relative to the gun muzzle plane (m): the target's
 * elevation above the muzzle, minus the Earth-curvature drop over the range.
 */
function impactHeightFor(targetRangeM, gunMuzzleElevM, targetGroundElevM) {
  const curvatureDropM = (targetRangeM * targetRangeM) / (2 * EARTH_RADIUS_M);
  return targetGroundElevM - gunMuzzleElevM - curvatureDropM;
}

// The fixed "as it sits" gun laying lives in data/belfast.js as a precomputed
// constant (see LAYING). The gun doesn't move; weather changes the fall of
// shot, not the laying. solveElevationForRange in engine.js stays available for
// scripts/precompute-laying.mjs if the underlying geometry ever changes.

/**
 * Map a fired shot to a ground impact point: travel downrange along the bearing,
 * then offset laterally by windage (deflection, +ve to the right of the line).
 */
function impactPoint(azimuthDeg, downrangeM, windageM) {
  const along = destinationPoint(BELFAST.position, azimuthDeg, downrangeM);
  if (!windageM) return along;
  return destinationPoint(along, (azimuthDeg + 90) % 360, windageM);
}

/**
 * Fire the fixed laying through the current conditions and report the fall of shot.
 * @param {{weather?: import('../weather.js').Weather|null, geometry?: object}} [options]
 * @returns {Promise<ImpactResult>}
 */
export async function computeImpact(options = {}) {
  const { weather = null, geometry = null, tide = null } = options;

  const { targetRangeM } = LAYING;
  const targetGroundElevM = geometry?.targetGroundElevM ?? TARGET.groundElevM;
  const gunGroundElevM = geometry?.gunGroundElevM ?? BELFAST.groundElevM;

  // The laying is fixed. Tide moves the live waterline → the muzzle → where the
  // fixed laying's shell actually lands (a tiny, ~metres effect).
  const liveMuzzleM = (tide?.levelMAOD ?? gunGroundElevM) + BELFAST.muzzleHeightM;
  const impactHeightM = impactHeightFor(targetRangeM, liveMuzzleM, targetGroundElevM);

  const laying = LAYING;

  // Coriolis is always physical; weather is optional.
  const coriolis = { latitudeDeg: BELFAST.position.lat, azimuthDeg: laying.azimuthDeg };
  let atmo;
  let winds;
  let profilePts = null;
  if (weather) {
    atmo = makeAtmo(weather.surface);
    // Map winds-aloft to downrange layers using a nominal (still-air) trajectory.
    profilePts = await trajectoryProfile(laying.elevationDeg, { impactHeightM });
    winds = makeWindLayers(weather.profile, profilePts, laying.azimuthDeg);
  }
  const conditions = { atmo, winds, coriolis, impactHeightM };

  const shot = await fireAtElevation(laying.elevationDeg, conditions);
  const impact = impactPoint(laying.azimuthDeg, shot.rangeM, shot.windageM);
  const missM = distanceMeters(impact, TARGET.position);

  // The real (curved) ground track: each step's downrange + lateral windage,
  // mapped to lat/lon. Bows with crosswind shear + Coriolis + spin drift.
  const track = shot.track.map((t) => {
    const p = impactPoint(laying.azimuthDeg, t.downrangeM, t.windageM);
    return [p.lat, p.lon];
  });

  // CEP = intrinsic gun dispersion ⊕ uncertainty in our knowledge of the
  // conditions (forecast wind/temperature error). Combined in quadrature.
  const gun = await computeDispersion(laying.elevationDeg, shot.rangeM, conditions);
  const met = weather
    ? await metUncertaintySigmas({ laying, weather, profilePts, conditions, shot })
    : { sigmaRangeM: 0, sigmaDefM: 0 };
  const sigmaRangeM = Math.hypot(gun.sigmaRangeM, met.sigmaRangeM);
  const sigmaDefM = Math.hypot(gun.sigmaDefM, met.sigmaDefM);

  return {
    impact,
    track,
    rangeM: shot.rangeM,
    bearingDeg: laying.azimuthDeg,
    elevationDeg: laying.elevationDeg,
    layingAssumed: laying.assumed,
    tofS: shot.tofS,
    impactVelMs: shot.impactVelMs,
    descentDeg: shot.descentDeg,
    apexM: shot.apexM,

    // Miss decomposed in the shooter frame.
    missM,
    rangeErrorM: shot.rangeM - targetRangeM, // +ve = over (long)
    deflectionM: shot.windageM, // +ve = right of the line of fire
    missBearingDeg: missM > 1 ? bearingDeg(TARGET.position, impact) : null,

    // Total CEP + its components.
    cepM: cepFromSigmas(sigmaRangeM, sigmaDefM),
    cepGunM: cepFromSigmas(gun.sigmaRangeM, gun.sigmaDefM),
    cepMetM: met.sigmaRangeM || met.sigmaDefM ? cepFromSigmas(met.sigmaRangeM, met.sigmaDefM) : 0,
    rangePEm: PE_PER_SIGMA * sigmaRangeM,
    deflectionPEm: PE_PER_SIGMA * sigmaDefM,
    ellipse: {
      semiMajorM: ELLIPSE_50_PER_SIGMA * sigmaRangeM,
      semiMinorM: ELLIPSE_50_PER_SIGMA * sigmaDefM,
      orientationDeg: laying.azimuthDeg
    },

    conditions: weather ? summariseConditions(weather, shot.apexM) : null,
    tide: tide ? { levelMAOD: tide.levelMAOD, dateTime: tide.dateTime, station: tide.station } : null,
    effects: { coriolis: true, curvature: true, weather: Boolean(weather) },
    onTarget: laying.reachesTarget,
    phase: 3,
    note: weather
      ? 'Live weather (winds aloft + air density), Earth curvature and Coriolis applied. CEP includes forecast uncertainty.'
      : 'ICAO standard atmosphere, with Earth curvature and Coriolis. No live weather — CEP is gun dispersion only.',
    computedAt: Date.now()
  };
}

/**
 * Uncertainty in the mean point of impact from imperfect knowledge of the
 * conditions: propagate the forecast wind-speed, wind-direction and temperature
 * errors through the engine (one-sided finite differences against the base
 * shot), returning 1-sigma range/deflection contributions in metres.
 */
async function metUncertaintySigmas({ laying, weather, profilePts, conditions, shot }) {
  const U = FORECAST_UNCERTAINTY;
  const az = laying.azimuthDeg;
  const fireWith = (override) =>
    fireAtElevation(laying.elevationDeg, { ...conditions, ...override });

  // Wind speed: nudge every level up by dws m/s.
  const dws = 2;
  const wsWinds = makeWindLayers(
    weather.profile.map((p) => ({ ...p, speedMs: Math.max(0, p.speedMs + dws) })),
    profilePts,
    az
  );
  const sWs = await fireWith({ winds: wsWinds });

  // Wind direction: rotate every level by ddir degrees.
  const ddir = 10;
  const wdWinds = makeWindLayers(
    weather.profile.map((p) => ({ ...p, dirFromDeg: (p.dirFromDeg + ddir + 360) % 360 })),
    profilePts,
    az
  );
  const sWd = await fireWith({ winds: wdWinds });

  // Temperature (air density): nudge surface temp by dT °C.
  const dT = 5;
  const sT = await fireWith({
    atmo: makeAtmo({ ...weather.surface, tempC: weather.surface.tempC + dT })
  });

  const dR = (s, d) => (s.rangeM - shot.rangeM) / d;
  const dD = (s, d) => (s.windageM - shot.windageM) / d;
  return {
    sigmaRangeM: Math.hypot(
      dR(sWs, dws) * U.windSpeedMs,
      dR(sWd, ddir) * U.windDirDeg,
      dR(sT, dT) * U.tempC
    ),
    sigmaDefM: Math.hypot(
      dD(sWs, dws) * U.windSpeedMs,
      dD(sWd, ddir) * U.windDirDeg,
      dD(sT, dT) * U.tempC
    )
  };
}

/**
 * Fire an EXPLICIT laying (bearing + elevation) through the conditions — the
 * hook for "as it literally sits" once the museum's barrel angle is known.
 * Returns where that shell lands (not necessarily near the target).
 */
export async function fireAtAngles(elevationDeg, azimuthDeg, options = {}) {
  const { weather = null, geometry = null } = options;
  const targetRangeM = distanceMeters(BELFAST.position, TARGET.position);
  const gunMuzzleElevM = (geometry?.gunGroundElevM ?? BELFAST.groundElevM) + BELFAST.muzzleHeightM;
  const targetGroundElevM = geometry?.targetGroundElevM ?? TARGET.groundElevM;
  const impactHeightM = impactHeightFor(targetRangeM, gunMuzzleElevM, targetGroundElevM);
  const coriolis = { latitudeDeg: BELFAST.position.lat, azimuthDeg };
  let atmo;
  let winds;
  if (weather) {
    atmo = makeAtmo(weather.surface);
    const pts = await trajectoryProfile(elevationDeg, { impactHeightM });
    winds = makeWindLayers(weather.profile, pts, azimuthDeg);
  }
  const shot = await fireAtElevation(elevationDeg, { atmo, winds, coriolis, impactHeightM });
  return {
    impact: impactPoint(azimuthDeg, shot.rangeM, shot.windageM),
    rangeM: shot.rangeM,
    bearingDeg: azimuthDeg,
    elevationDeg,
    tofS: shot.tofS,
    impactVelMs: shot.impactVelMs,
    descentDeg: shot.descentDeg,
    apexM: shot.apexM
  };
}

/** Compact weather summary for the panel, incl. the wind at apogee altitude. */
function summariseConditions(weather, apexM) {
  const aloft = windAtAltitude(weather.profile, apexM);
  return {
    tempC: weather.surface.tempC,
    pressureHpa: weather.surface.pressureHpa,
    humidity: weather.surface.humidity,
    surfaceWind: { speedMs: weather.surface.windSpeedMs, dirDeg: weather.surface.windDirDeg },
    windAloft: { speedMs: aloft.speedMs, dirDeg: aloft.dirFromDeg, altitudeM: apexM },
    source: weather.source,
    obsTime: weather.obsTime,
    validTime: weather.validTime,
    fetchedAt: weather.fetchedAt,
    historical: weather.historical ?? false
  };
}

/**
 * @typedef {Object} ImpactResult
 * @property {{lat:number, lon:number}} impact
 * @property {Array<[number,number]>} track  Curved ground track [lat,lon] from ship to impact.
 * @property {number} rangeM
 * @property {number} bearingDeg
 * @property {number|null} elevationDeg
 * @property {boolean} layingAssumed
 * @property {number} tofS
 * @property {number} impactVelMs
 * @property {number} descentDeg
 * @property {number} apexM
 * @property {number} missM
 * @property {number} rangeErrorM
 * @property {number} deflectionM
 * @property {number|null} missBearingDeg
 * @property {number} cepM        Total CEP (gun dispersion ⊕ forecast uncertainty).
 * @property {number} cepGunM     CEP from gun dispersion alone.
 * @property {number} cepMetM     CEP-equivalent from forecast uncertainty alone.
 * @property {number} rangePEm
 * @property {number} deflectionPEm
 * @property {{semiMajorM:number, semiMinorM:number, orientationDeg:number}} ellipse
 * @property {object|null} conditions
 * @property {{coriolis:boolean, curvature:boolean, weather:boolean}} effects
 * @property {boolean} onTarget
 * @property {number} phase
 * @property {string} note
 * @property {number} computedAt
 */
