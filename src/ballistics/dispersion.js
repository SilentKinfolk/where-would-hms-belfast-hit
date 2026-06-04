// Dispersion maths: turn range/deflection standard deviations into a CEP and a
// 50%-containment ellipse. Kept separate from the trajectory engine so it's
// pure and trivially testable.

export const PE_PER_SIGMA = 0.6745; // probable error = 0.6745 * sigma
// Semi-axis of the 2-D ellipse containing 50% of the landing probability, in units of sigma:
// solves 1 - exp(-s^2/2) = 0.5  ->  s = sqrt(2 ln 2).
export const ELLIPSE_50_PER_SIGMA = Math.sqrt(2 * Math.LN2); // ~1.1774

// Small seeded PRNG (mulberry32) so the CEP is deterministic between loads.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Circular Error Probable (radius containing 50% of the landing probability) for
 * a zero-mean bivariate-normal fall of shot with independent standard deviations
 * sigmaX, sigmaY. Computed as the median impact radius of a seeded Monte-Carlo
 * sample, exact for any ellipticity, with no closed-form approximation.
 */
export function cepFromSigmas(sigmaX, sigmaY, n = 6000) {
  const rand = mulberry32(0x9e3779b9);
  const radii = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = gaussian(rand) * sigmaX;
    const y = gaussian(rand) * sigmaY;
    radii[i] = Math.hypot(x, y);
  }
  radii.sort((a, b) => a - b);
  return radii[Math.floor(n / 2)];
}
