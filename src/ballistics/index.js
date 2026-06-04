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
import { windAtAltitude, effectiveSurfaceTempC } from '../weather.js';

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
 * @param {{
 *   weather?: import('../weather.js').Weather|null,
 *   geometry?: object,
 *   tide?: object|null,
 *   ensembleSigmas?: {sigmaTempC?:number|null, sigmaWindSpeedMs?:number|null, sigmaWindDirDeg?:number|null, source?:string, nMembers?:number}|null,
 *   groundElevAt?: (lat:number, lon:number) => number|null,
 *   demSource?: string|null
 * }} [options]
 * @returns {Promise<ImpactResult>}
 */
export async function computeImpact(options = {}) {
  const {
    weather = null,
    geometry = null,
    tide = null,
    ensembleSigmas = null,
    groundElevAt = null,
    demSource = null
  } = options;

  const { targetRangeM } = LAYING;
  const targetGroundElevM = geometry?.targetGroundElevM ?? TARGET.groundElevM;
  const gunGroundElevM = geometry?.gunGroundElevM ?? BELFAST.groundElevM;

  // The laying is fixed. Tide moves the live waterline → the muzzle → where the
  // fixed laying's shell actually lands (a tiny, ~metres effect).
  const liveMuzzleM = (tide?.levelMAOD ?? gunGroundElevM) + BELFAST.muzzleHeightM;
  let groundAtImpactM = targetGroundElevM;
  let impactHeightM = impactHeightFor(targetRangeM, liveMuzzleM, groundAtImpactM);

  const laying = LAYING;

  // Coriolis is always physical; weather is optional.
  const coriolis = { latitudeDeg: BELFAST.position.lat, azimuthDeg: laying.azimuthDeg };
  let atmo;
  let winds;
  let profilePts = null;
  let effSurfaceTempC = null;
  if (weather) {
    // Map winds-aloft to downrange layers using a nominal (still-air) trajectory,
    // and use the same altitude samples to project the measured upper-air
    // temperatures onto a single effective surface T (see weather.js).
    profilePts = await trajectoryProfile(laying.elevationDeg, { impactHeightM });
    effSurfaceTempC = effectiveSurfaceTempC(weather.profile, profilePts, weather.surface);
    atmo = makeAtmo({ ...weather.surface, tempC: effSurfaceTempC });
    winds = makeWindLayers(weather.profile, profilePts, laying.azimuthDeg);
  }
  // Magazine temperature → js-ballistics adjusts MV via powder sensitivity.
  const powderTempC = weather?.magazineTempC ?? null;
  const conditions = { atmo, winds, coriolis, impactHeightM, powderTempC };

  // Iterate the ground intersection: each pass fires with the impactHeight derived
  // from the previous impact's actual ground elevation. Without a DEM the loop
  // exits after one pass; with a DEM it usually converges in 2-3 passes because
  // each step moves the impact only metres horizontally.
  let shot = await fireAtElevation(laying.elevationDeg, conditions);
  let impact = impactPoint(laying.azimuthDeg, shot.rangeM, shot.windageM);
  if (groundElevAt) {
    for (let iter = 0; iter < 4; iter++) {
      const g = groundElevAt(impact.lat, impact.lon);
      if (!Number.isFinite(g)) break;
      const rangeToImpact = distanceMeters(BELFAST.position, impact);
      const nextImpactHeightM = impactHeightFor(rangeToImpact, liveMuzzleM, g);
      if (Math.abs(nextImpactHeightM - conditions.impactHeightM) < 0.05) {
        groundAtImpactM = g;
        impactHeightM = nextImpactHeightM;
        break;
      }
      conditions.impactHeightM = nextImpactHeightM;
      impactHeightM = nextImpactHeightM;
      groundAtImpactM = g;
      shot = await fireAtElevation(laying.elevationDeg, conditions);
      const next = impactPoint(laying.azimuthDeg, shot.rangeM, shot.windageM);
      if (distanceMeters(impact, next) < 1) {
        impact = next;
        break;
      }
      impact = next;
    }
  }
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
    ? await metUncertaintySigmas({ laying, weather, profilePts, conditions, shot, ensembleSigmas })
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
    forecastSigmas: met.sigmas ?? null,
    rangePEm: PE_PER_SIGMA * sigmaRangeM,
    deflectionPEm: PE_PER_SIGMA * sigmaDefM,
    ellipse: {
      semiMajorM: ELLIPSE_50_PER_SIGMA * sigmaRangeM,
      semiMinorM: ELLIPSE_50_PER_SIGMA * sigmaDefM,
      orientationDeg: laying.azimuthDeg
    },

    conditions: weather ? summariseConditions(weather, shot.apexM) : null,
    tide: tide ? { levelMAOD: tide.levelMAOD, dateTime: tide.dateTime, station: tide.station } : null,
    groundElevAtImpactM: groundAtImpactM,
    demSource: groundElevAt ? demSource ?? 'DEM' : null,
    effects: { coriolis: true, curvature: true, weather: Boolean(weather), dem: Boolean(groundElevAt) },
    onTarget: laying.reachesTarget,
    phase: 3,
    note: weather
      ? 'Live weather (winds aloft + air density), Earth curvature and Coriolis applied. CEP includes forecast uncertainty.'
      : 'ICAO standard atmosphere, with Earth curvature and Coriolis. No live weather — CEP is gun dispersion only.',
    computedAt: Date.now()
  };
}

/**
 * Resolve 1-sigma forecast uncertainties. Prefers the live ensemble spread
 * (ICON-EPS, see weather.fetchEnsembleUncertainty), folds gust margin into the
 * wind-speed sigma, and falls back to the FORECAST_UNCERTAINTY estimates in
 * belfast.js for anything missing.
 */
function resolveForecastSigmas(weather, ensembleSigmas) {
  const U = FORECAST_UNCERTAINTY;
  const gust = weather?.surface?.windGustMs;
  const mean = weather?.surface?.windSpeedMs;
  // WMO gust = peak 3-s within the hour. Over a 50-s flight the wind varies
  // between mean and gust; treat half the gust-minus-mean spread as an extra
  // 1-sigma contribution in quadrature with the ensemble spread.
  const gustMargin =
    Number.isFinite(gust) && Number.isFinite(mean) && gust > mean ? (gust - mean) / 2 : 0;

  const ensWs = ensembleSigmas?.sigmaWindSpeedMs;
  const ensWd = ensembleSigmas?.sigmaWindDirDeg;
  const ensT = ensembleSigmas?.sigmaTempC;
  return {
    windSpeedMs: Math.hypot(Number.isFinite(ensWs) ? ensWs : U.windSpeedMs, gustMargin),
    windDirDeg: Number.isFinite(ensWd) ? ensWd : U.windDirDeg,
    tempC: Number.isFinite(ensT) ? ensT : U.tempC,
    source: ensembleSigmas?.source ?? 'static estimates',
    gustMargin
  };
}

/**
 * Uncertainty in the predicted impact point from imperfect knowledge of the
 * conditions: propagate the forecast wind-speed, wind-direction and temperature
 * errors through the engine (central finite differences, so a nonlinear
 * response, mainly wind direction at crosswind angles, doesn't bias the slope),
 * returning 1-sigma range/deflection contributions in metres.
 */
async function metUncertaintySigmas({ laying, weather, profilePts, conditions, ensembleSigmas }) {
  const sigmas = resolveForecastSigmas(weather, ensembleSigmas);
  const az = laying.azimuthDeg;
  const fireWith = (override) =>
    fireAtElevation(laying.elevationDeg, { ...conditions, ...override });
  const windsFrom = (mut) => makeWindLayers(weather.profile.map(mut), profilePts, az);

  // Wind speed: nudge every level by ±dws m/s.
  const dws = 2;
  const sWsHi = await fireWith({ winds: windsFrom((p) => ({ ...p, speedMs: Math.max(0, p.speedMs + dws) })) });
  const sWsLo = await fireWith({ winds: windsFrom((p) => ({ ...p, speedMs: Math.max(0, p.speedMs - dws) })) });

  // Wind direction: rotate every level by ±ddir degrees.
  const ddir = 10;
  const sWdHi = await fireWith({ winds: windsFrom((p) => ({ ...p, dirFromDeg: (p.dirFromDeg + ddir + 360) % 360 })) });
  const sWdLo = await fireWith({ winds: windsFrom((p) => ({ ...p, dirFromDeg: (p.dirFromDeg - ddir + 360) % 360 })) });

  // Temperature (air density): shift the WHOLE profile by ±dT °C (correlated
  // forecast bias) and re-derive the effective surface T from the shifted
  // observations. Perturbing surface T alone would be near-invisible because
  // the effective T is fitted to the aloft profile.
  const dT = 5;
  const tempShot = async (sign) => {
    const prof = weather.profile.map((p) => ({
      ...p,
      tempC: Number.isFinite(p.tempC) ? p.tempC + sign * dT : p.tempC
    }));
    const surf = { ...weather.surface, tempC: weather.surface.tempC + sign * dT };
    const tEff = effectiveSurfaceTempC(prof, profilePts, surf);
    return fireWith({ atmo: makeAtmo({ ...surf, tempC: tEff }) });
  };
  const sTHi = await tempShot(1);
  const sTLo = await tempShot(-1);

  const dR = (hi, lo, d) => (hi.rangeM - lo.rangeM) / (2 * d);
  const dD = (hi, lo, d) => (hi.windageM - lo.windageM) / (2 * d);
  return {
    sigmaRangeM: Math.hypot(
      dR(sWsHi, sWsLo, dws) * sigmas.windSpeedMs,
      dR(sWdHi, sWdLo, ddir) * sigmas.windDirDeg,
      dR(sTHi, sTLo, dT) * sigmas.tempC
    ),
    sigmaDefM: Math.hypot(
      dD(sWsHi, sWsLo, dws) * sigmas.windSpeedMs,
      dD(sWdHi, sWdLo, ddir) * sigmas.windDirDeg,
      dD(sTHi, sTLo, dT) * sigmas.tempC
    ),
    sigmas
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
    surfaceGustMs: weather.surface.windGustMs ?? null,
    windAloft: { speedMs: aloft.speedMs, dirDeg: aloft.dirFromDeg, altitudeM: apexM },
    magazineTempC: weather.magazineTempC ?? null,
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
