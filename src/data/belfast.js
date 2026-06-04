// Single source of truth for the ship, the target, and the gun.
// Coordinates are WGS84 decimal degrees.

export const BELFAST = {
  name: 'HMS Belfast',
  // Firing origin = the FORWARD (A/B) turret location, not the ship centroid —
  // confirmed from satellite imagery. The bow points roughly WNW (upstream),
  // so the guns sit ~100 m WNW of the generic museum-ship marker.
  position: { lat: 51.50676428297279, lon: -0.08218830045513636 },
  description:
    'Town-class light cruiser, museum ship moored in the Pool of London since 1971.',
  groundElevM: 1, // sea level at the mooring (overridden by live elevation lookup)
  muzzleHeightM: 13 // height of the A/B turret guns above the waterline (approx)
};

export const TARGET = {
  name: 'London Gateway Services',
  aka: 'formerly Scratchwood Services, M1',
  // Derived from Ordnance Survey grid reference TQ 202 939 (WGS84).
  position: { lat: 51.63107, lon: -0.26473 },
  groundElevM: 75, // ground elevation (overridden by live elevation lookup)
  note: "The forward 6-inch turrets have famously been trained on this spot since 1971."
};

// The fixed "as it sits" gun laying. Derived once from the constants above:
// azimuth = true bearing BELFAST → TARGET; elevation = the angle that lands a
// shell on the target under ICAO standard atmosphere, over the curved Earth at
// the target's elevation. Reproduce with: node scripts/precompute-laying.mjs
// Treated as the actual gun setting until confirmed from the ship in person.
export const LAYING = {
  azimuthDeg: 317.68247,
  elevationDeg: 24.91250,
  targetRangeM: 18714.406,
  impactHeightM: 33.514,
  assumed: true,
  reachesTarget: true
};

// BL 6"/50 Mk XXIII — Belfast's main armament (twelve guns, four triple turrets).
// Sources: Wikipedia / NavWeaps.
export const GUN = {
  designation: 'BL 6"/50 Mk XXIII',
  calibreMm: 152,
  shellMassKg: 50.8, // 112 lb CPBC / HE
  shellMassLb: 112,
  muzzleVelocityMs: 841, // 2,758 ft/s
  muzzleVelocityFps: 2758,
  projectileLengthIn: 27, // ~27 in (68.5 cm) — needed for spin-drift stability
  riflingTwistCalibers: 30, // uniform right-hand, 1 turn in 30 calibres
  maxRangeM: 23300, // 25,480 yds at 45 degrees elevation
  maxRangeYds: 25480,
  maxElevationDeg: 45,
  turrets: 4,
  gunsPerTurret: 3,

  // Drag model for the exterior-ballistics engine (js-ballistics).
  // The shell's true drag curve isn't published, so we use a standard drag
  // table (G7) with a ballistic coefficient fitted to the full NavWeaps
  // range-vs-elevation table. The fit reproduces all six tabulated rows to
  // within ~1.3% on range, and matches the tabulated time-of-flight, striking
  // velocity and angle of fall closely (see scripts/calibrate.mjs).
  //
  // NOTE on velocity: the NavWeaps range-table header reads verbatim "Range of
  // CPBC 112 lbs. projectiles for MV = 2,700 fps (823 mps)" — the service /
  // fire-control velocity, which is what the ballistic model uses (modelMvMs).
  // The 2,758 fps (841 m/s) above is the higher "new gun" muzzle velocity, kept
  // for the spec display. (Header re-verified against the source page 2026-06.)
  drag: {
    table: 'G7',
    ballisticCoefficient: 2.82,
    modelMvMs: 823,
    calibratedAgainst: 'NavWeaps 6"/50 Mk XXIII range table (CPBC 112 lb)',
    rmsRangeError: 0.013
  },

  // Propellant sensitivity. RN Range Tables for cordite SC are quoted at the
  // 26.7 °C reference propellant temperature; muzzle velocity shifts roughly
  // +0.8 m/s per °C above that, -0.8 m/s per °C below. js-ballistics applies
  // this natively via Ammo.usePowderSensitivity once we set powderTemp
  // (reference) + tempModifier (m/s per °C) and pass the current magazine
  // temperature on Atmo.
  //
  // The 0.8 m/s/°C figure is the standard cordite SC sensitivity from
  // Admiralty propellant calibration; the specific 6"/50 Mk XXIII number isn't
  // separately published, but cordite SC was the standard charge.
  propellant: {
    referenceTempC: 26.7, // RN range-table calibration temperature
    mvSensitivityMsPerC: 0.8, // ~0.1 % of muzzle velocity per °C, typical for cordite SC
    note: 'Cordite SC nominal sensitivity; current magazine temperature comes from a soil-temp proxy (see weather.js).'
  },

  // Round-to-round uncertainty in where a SINGLE shell lands (this tool models
  // one shell, never a salvo). We can't know this shell's exact muzzle velocity
  // or barrel jump, so the predicted impact carries an elliptical uncertainty
  // zone, long in range and narrow in deflection; its 50% radius is the CEP.
  // PE = 0.6745 * sigma.
  //
  // The shell's true probable errors aren't published, so these are physically
  // reasonable estimates (muzzle velocity dominates the range axis). They want a
  // real range table to replace them: a BR.224 6"/50 table would give measured
  // dispersion and a drift column. See TODO.md / README.
  //
  // NOT covered here: uncertainty about the laying itself. Elevation and azimuth
  // are solved-to-hit, not measured on the ship, so the true single-shell zone
  // is wider than this until the real laying is gathered. Left as a data gap
  // rather than guessed at.
  dispersion: {
    muzzleVelocityPE_ms: 3.0, // round-to-round MV PE; ~0.36% of MV, top of the 0.2-0.4% cordite range
    elevationLayingPE_mil: 1.0, // quadrant-elevation laying + barrel jump PE
    deflectionDispersionPE_mil: 0.3, // round-to-round cross-line scatter (gun jump, training slack)
    // No shell-weight term: this BC-based drag model is governed by the ballistic
    // coefficient and muzzle velocity, so a weight perturbation at fixed BC has no
    // effect on range (dR/dm = 0 in the engine); its effect is subsumed into MV PE.
  }
};

// How well we actually KNOW the current conditions (1-sigma). The live met is an
// observation/forecast with error, and conditions drift between updates; that
// uncertainty in the inputs becomes uncertainty in the predicted impact point,
// which (combined with the gun's own dispersion) widens the CEP. Estimates,
// tunable. Wind perturbations are applied to the whole vertical profile at once
// (a correlated, systematic error — the realistic worst case for fall of shot).
export const FORECAST_UNCERTAINTY = {
  windSpeedMs: 2.0, // 1-sigma error in wind speed at every level
  windDirDeg: 15, // 1-sigma error in wind direction
  tempC: 2.0 // 1-sigma error in air temperature (acts via air density)
};
