// Low-level wrapper around js-ballistics (C++/WASM point-mass engine).
//
// This isolates every js-ballistics detail in one place. The rest of the app
// talks to the higher-level computeImpact() in ./index.js, never to this file
// directly. The `conditions` object is the seam Phase 2 fills with real
// meteorology — Phase 1 just leaves it empty and gets ICAO standard atmosphere.

import {
  Calculator,
  Shot,
  Weapon,
  Ammo,
  DragModel,
  DragTables,
  Atmo,
  Wind,
  UNew,
  Distance,
  Velocity,
  Angular,
  TrajFlag,
  IntegrationMethod
} from 'js-ballistics';

import { GUN } from '../data/belfast.js';
import { windAtAltitude } from '../weather.js';

const DRAG_TABLES = { G1: DragTables.G1, G7: DragTables.G7 };

// One Calculator (and one WASM instance) reused for the whole session.
const calc = new Calculator({
  method: IntegrationMethod.RK4,
  config: {
    minimumVelocity: 0,
    minimumAltitude: -2000, // ft — let the shell pass through 0 so ZERO_DOWN fires
    maximumDrop: -500000
  }
});

/**
 * @typedef {Object} Conditions
 * @property {import('js-ballistics').Atmo} [atmo]   Atmosphere (default: ICAO standard).
 * @property {import('js-ballistics').Wind[]} [winds] Wind layers (Phase 2).
 * @property {{latitudeDeg:number, azimuthDeg?:number}} [coriolis] Coriolis.
 * @property {number} [mvMs] Muzzle-velocity override (m/s); default GUN.drag.modelMvMs.
 * @property {number} [shellMassKg] Shell mass override (kg); default GUN.shellMassKg.
 * @property {number} [powderTempC] Propellant (magazine) temperature, °C; if
 *   provided, js-ballistics auto-adjusts MV via Ammo.usePowderSensitivity.
 * @property {number} [impactHeightM] Ground height of the impact relative to the
 *   muzzle plane (m); lets us model Earth curvature + target elevation. Default 0.
 */

const MIL_RAD = 0.0009817477; // one NATO mil, in radians
const DEG = Math.PI / 180;
const PE_PER_SIGMA = 0.6745; // probable error = 0.6745 * standard deviation

function buildShot(elevationDeg, conditions = {}) {
  const calibreIn = GUN.calibreMm / 25.4;
  const shellMassKg = conditions.shellMassKg ?? GUN.shellMassKg;
  const dm = new DragModel({
    bc: GUN.drag.ballisticCoefficient,
    dragTable: DRAG_TABLES[GUN.drag.table],
    weight: UNew.Gram(shellMassKg * 1000),
    diameter: UNew.Inch(calibreIn),
    length: UNew.Inch(GUN.projectileLengthIn) // enables spin-drift stability calc
  });
  const refMv = conditions.mvMs ?? GUN.drag.modelMvMs;
  const usePowderTemp =
    Number.isFinite(conditions.powderTempC) && GUN.propellant?.mvSensitivityMsPerC;
  // js-ballistics' tempModifier is NORMALISED, not raw m/s/°C: the engine's
  // formula is dMV = tempModifier × (v0 / 15) × dT. So the modifier we pass
  // must scale our true sensitivity (m/s per °C) by 15 / referenceMv. See
  // Ammo.getVelocityForTemp in node_modules/js-ballistics/dist/index.js.
  const tempModifier = usePowderTemp
    ? (GUN.propellant.mvSensitivityMsPerC * 15) / refMv
    : 0;
  const ammo = new Ammo({
    dm,
    mv: UNew.MPS(refMv),
    powderTemp: usePowderTemp ? UNew.Celsius(GUN.propellant.referenceTempC) : undefined,
    tempModifier,
    usePowderSensitivity: Boolean(usePowderTemp)
  });
  const weapon = new Weapon({
    sightHeight: UNew.Meter(0),
    // Right-hand rifling, 1 turn per `riflingTwistCalibers` calibres → spin drift.
    twist: UNew.Inch(calibreIn * GUN.riflingTwistCalibers),
    zeroElevation: UNew.Degree(elevationDeg)
  });
  // If we have a magazine temp and an atmo, set powderTemperature on the atmo
  // so the engine's auto-correction uses it; otherwise leave the atmo alone.
  let atmo = conditions.atmo ?? Atmo.standard();
  if (usePowderTemp) {
    atmo = new Atmo({
      altitude: atmo.altitude,
      pressure: atmo.pressure,
      temperature: atmo.temperature,
      humidity: atmo.humidity,
      powderTemperature: UNew.Celsius(conditions.powderTempC)
    });
  }
  const shot = new Shot({
    weapon,
    ammo,
    atmo,
    winds: conditions.winds
  });
  if (conditions.coriolis?.latitudeDeg != null) {
    shot.latitudeDeg = conditions.coriolis.latitudeDeg;
    if (conditions.coriolis.azimuthDeg != null) {
      shot.azimuthDeg = conditions.coriolis.azimuthDeg;
    }
  }
  return shot;
}

/**
 * @typedef {Object} ShotResult
 * @property {number} rangeM      Ground range to impact (m).
 * @property {number} tofS        Time of flight (s).
 * @property {number} impactVelMs Striking velocity (m/s).
 * @property {number} descentDeg  Descent angle at impact (deg below horizontal, positive).
 * @property {number} apexM       Apogee altitude (m).
 * @property {number} windageM    Lateral deflection at impact (m); 0 with no wind/Coriolis.
 */

const lerp = (a, b, f) => a + (b - a) * f;

// Fire and return a dense list of trajectory points plus apogee.
async function fireDense(elevationDeg, conditions = {}) {
  const hit = await calc.fire({
    shot: buildShot(elevationDeg, conditions),
    trajectoryRange: UNew.Meter(30000),
    trajectoryStep: UNew.Meter(200),
    filterFlags: TrajFlag.ALL,
    raiseRangeError: false
  });
  const points = hit.trajectory.map((p) => ({
    downrangeM: p.distance.In(Distance.Meter),
    altitudeM: p.height.In(Distance.Meter),
    tofS: p.time,
    velMs: p.velocity.In(Velocity.MPS),
    windageM: p.windage?.In(Distance.Meter) ?? 0,
    angleDeg: p.angle?.In(Angular.Degree) ?? 0
  }));
  const apexFlag = hit.flag(TrajFlag.APEX);
  const apexM = apexFlag
    ? apexFlag.height.In(Distance.Meter)
    : points.reduce((m, p) => Math.max(m, p.altitudeM), -Infinity);
  return { points, apexM };
}

// Find the descending crossing of `impactHeightM` and interpolate the impact.
function interpImpact(points, impactHeightM) {
  let apexI = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].altitudeM > points[apexI].altitudeM) apexI = i;
  }
  let j = -1;
  for (let i = Math.max(apexI, 1); i < points.length; i++) {
    if (points[i].altitudeM <= impactHeightM) {
      j = i;
      break;
    }
  }
  if (j <= 0) {
    const last = points[points.length - 1];
    return {
      rangeM: last.downrangeM,
      tofS: last.tofS,
      impactVelMs: last.velMs,
      descentDeg: Math.abs(last.angleDeg),
      windageM: last.windageM
    };
  }
  const a = points[j - 1];
  const b = points[j];
  const denom = a.altitudeM - b.altitudeM;
  const f = denom !== 0 ? (a.altitudeM - impactHeightM) / denom : 0;
  return {
    rangeM: lerp(a.downrangeM, b.downrangeM, f),
    tofS: lerp(a.tofS, b.tofS, f),
    impactVelMs: lerp(a.velMs, b.velMs, f),
    descentDeg: Math.abs(lerp(a.angleDeg, b.angleDeg, f)),
    windageM: lerp(a.windageM, b.windageM, f)
  };
}

/** Fire at a quadrant elevation and report where (and how) the shell lands,
 *  plus the ground track (downrange + lateral windage at each step up to impact). */
export async function fireAtElevation(elevationDeg, conditions = {}) {
  const { points, apexM } = await fireDense(elevationDeg, conditions);
  const impact = interpImpact(points, conditions.impactHeightM ?? 0);
  const track = points
    .filter((p) => p.downrangeM <= impact.rangeM)
    .map((p) => ({ downrangeM: p.downrangeM, windageM: p.windageM }));
  track.push({ downrangeM: impact.rangeM, windageM: impact.windageM });
  return { ...impact, apexM, track };
}

/** The (downrange, altitude) profile of a shot — used to map winds aloft to
 *  downrange wind layers. */
export async function trajectoryProfile(elevationDeg, conditions = {}) {
  const { points } = await fireDense(elevationDeg, conditions);
  return points.map((p) => ({ downrangeM: p.downrangeM, altitudeM: p.altitudeM }));
}

/** Build a js-ballistics Atmo from parsed surface weather. */
export function makeAtmo(surface) {
  return new Atmo({
    altitude: UNew.Meter(surface.groundElevM ?? 0),
    temperature: UNew.Celsius(surface.tempC),
    pressure: UNew.hPa(surface.pressureHpa),
    humidity: surface.humidity
  });
}

/**
 * Turn a winds-aloft profile into downrange wind layers, by reading the wind at
 * the altitude the shell occupies at each downrange band (from `profile` points
 * of a nominal trajectory). Direction is converted from a meteorological "from"
 * compass bearing into the engine's frame: empirically js-ballistics treats
 * directionFrom 0 as a TAILWIND (blowing downrange), so the engine angle is the
 * wind's "blowing-toward" bearing relative to the line of fire = mf + 180 - B.
 */
export function makeWindLayers(windProfile, trajPoints, bearingDeg, bandM = 750) {
  if (!windProfile?.length || !trajPoints?.length) return undefined;
  const maxDown = trajPoints[trajPoints.length - 1].downrangeM;
  const altAtDownrange = (d) => {
    if (d <= trajPoints[0].downrangeM) return trajPoints[0].altitudeM;
    for (let i = 1; i < trajPoints.length; i++) {
      if (d <= trajPoints[i].downrangeM) {
        const a = trajPoints[i - 1];
        const b = trajPoints[i];
        const f = (d - a.downrangeM) / ((b.downrangeM - a.downrangeM) || 1);
        return lerp(a.altitudeM, b.altitudeM, f);
      }
    }
    return trajPoints[trajPoints.length - 1].altitudeM;
  };

  const winds = [];
  for (let d0 = 0; d0 < maxDown; d0 += bandM) {
    const d1 = Math.min(d0 + bandM, maxDown);
    const w = windAtAltitude(windProfile, altAtDownrange((d0 + d1) / 2));
    winds.push(
      new Wind({
        velocity: UNew.MPS(w.speedMs),
        directionFrom: UNew.Degree((w.dirFromDeg + 180 - bearingDeg + 360) % 360),
        untilDistance: UNew.Meter(d1)
      })
    );
  }
  return winds;
}

/**
 * Inverse solve: the low-angle quadrant elevation (deg) that lands the shell at
 * `targetRangeM`. Bisects the rising branch of range-vs-elevation in (0, 45].
 * Returns null if the target is beyond the gun's reach under these conditions.
 */
export async function solveElevationForRange(targetRangeM, conditions = {}) {
  const maxReach = (await fireAtElevation(GUN.maxElevationDeg, conditions)).rangeM;
  if (targetRangeM > maxReach) return null;

  let lo = 0.25;
  let hi = GUN.maxElevationDeg;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    const { rangeM } = await fireAtElevation(mid, conditions);
    if (rangeM < targetRangeM) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Intrinsic gun dispersion at the given laying, propagated through the
 * trajectory. Returns 1-sigma standard deviations of the fall of shot (metres)
 * in the range (down the line of fire) and deflection (cross) directions.
 * Range scatter combines round-to-round muzzle-velocity variation, elevation-
 * laying error, and shell-weight grading; deflection comes from lateral laying
 * error.
 * @returns {Promise<{sigmaRangeM:number, sigmaDefM:number}>}
 */
export async function computeDispersion(elevationDeg, rangeM, conditions = {}) {
  const d = GUN.dispersion;
  const baseMv = conditions.mvMs ?? GUN.drag.modelMvMs;
  const baseMass = conditions.shellMassKg ?? GUN.shellMassKg;

  // Trajectory sensitivities by central finite difference (6 extra fires).
  const dv = 5; // m/s
  const dq = 0.5; // deg
  const dm = 0.5; // kg — comfortably wider than the 50 g PE so finite diff is well-conditioned
  const rHiV = (await fireAtElevation(elevationDeg, { ...conditions, mvMs: baseMv + dv })).rangeM;
  const rLoV = (await fireAtElevation(elevationDeg, { ...conditions, mvMs: baseMv - dv })).rangeM;
  const dR_dv = (rHiV - rLoV) / (2 * dv); // m per (m/s)
  const rHiQ = (await fireAtElevation(elevationDeg + dq, conditions)).rangeM;
  const rLoQ = (await fireAtElevation(elevationDeg - dq, conditions)).rangeM;
  const dR_dQEdeg = (rHiQ - rLoQ) / (2 * dq); // m per degree
  const rHiM = (await fireAtElevation(elevationDeg, { ...conditions, shellMassKg: baseMass + dm })).rangeM;
  const rLoM = (await fireAtElevation(elevationDeg, { ...conditions, shellMassKg: baseMass - dm })).rangeM;
  const dR_dMassKg = (rHiM - rLoM) / (2 * dm); // m per kg

  const sigMv = d.muzzleVelocityPE_ms / PE_PER_SIGMA;
  const sigQEdeg = d.elevationLayingPE_mil * MIL_RAD / DEG / PE_PER_SIGMA;
  const sigMassKg = (d.shellWeightPE_kg ?? 0) / PE_PER_SIGMA;
  const sigmaRangeM = Math.hypot(
    dR_dv * sigMv,
    dR_dQEdeg * sigQEdeg,
    dR_dMassKg * sigMassKg
  );
  const sigmaDefM = (rangeM * d.deflectionLayingPE_mil * MIL_RAD) / PE_PER_SIGMA;
  return { sigmaRangeM, sigmaDefM };
}

/**
 * One-off calibration helper (not used at runtime): find the ballistic
 * coefficient that makes max-range-at-45deg equal `targetMaxRangeM`. Used to
 * derive GUN.drag.ballisticCoefficient; kept here so it can be re-run when we
 * refine against the full range table.
 */
export async function calibrateBallisticCoefficient(targetMaxRangeM, table = 'G1') {
  const saved = GUN.drag.ballisticCoefficient;
  const savedTable = GUN.drag.table;
  GUN.drag.table = table;
  let lo = 0.05;
  let hi = 40;
  for (let i = 0; i < 44; i++) {
    const mid = (lo + hi) / 2;
    GUN.drag.ballisticCoefficient = mid;
    const { rangeM } = await fireAtElevation(GUN.maxElevationDeg);
    if (rangeM < targetMaxRangeM) lo = mid;
    else hi = mid;
  }
  GUN.drag.ballisticCoefficient = saved;
  GUN.drag.table = savedTable;
  return (lo + hi) / 2;
}
