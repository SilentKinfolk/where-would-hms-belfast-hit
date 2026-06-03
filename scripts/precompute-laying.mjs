// Re-derive the LAYING constants in src/data/belfast.js.
// Run once whenever BELFAST.position, TARGET.position, or the gun/drag model
// change. Paste the printed numbers into src/data/belfast.js.
//
//   node scripts/precompute-laying.mjs

import { BELFAST, TARGET } from '../src/data/belfast.js';
import { distanceMeters, bearingDeg } from '../src/geo.js';
import { solveElevationForRange } from '../src/ballistics/engine.js';

const EARTH_RADIUS_M = 6371008.8;

const targetRangeM = distanceMeters(BELFAST.position, TARGET.position);
const azimuthDeg = bearingDeg(BELFAST.position, TARGET.position);

// Standard-atmo impact-height: target ground above the muzzle plane, minus the
// Earth-curvature drop over the range. Matches the no-tide path in ballistics/index.js.
const nominalMuzzleM = BELFAST.groundElevM + BELFAST.muzzleHeightM;
const curvatureDropM = (targetRangeM * targetRangeM) / (2 * EARTH_RADIUS_M);
const impactHeightM = TARGET.groundElevM - nominalMuzzleM - curvatureDropM;

const elevationDeg = await solveElevationForRange(targetRangeM, { impactHeightM });

console.log('export const LAYING = {');
console.log(`  azimuthDeg: ${azimuthDeg.toFixed(5)},`);
console.log(`  elevationDeg: ${elevationDeg.toFixed(5)},`);
console.log(`  targetRangeM: ${targetRangeM.toFixed(3)},`);
console.log(`  impactHeightM: ${impactHeightM.toFixed(3)},`);
console.log('  assumed: true,');
console.log('  reachesTarget: true');
console.log('};');
