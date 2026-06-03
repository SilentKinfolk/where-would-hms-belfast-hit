// Load and sample the bundled EA LIDAR Composite DTM tile, used server-side
// for DEM-aware impact intersection. The browser doesn't need this — it reads
// the cron's pre-rendered impacts.json. Only Node imports here.
//
// Binary format: see scripts/fetch-dem.mjs.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const NO_DATA = 0xffff;
const DEFAULT_PATH = fileURLToPath(new URL('../public/dem/london-gateway.bin', import.meta.url));

/** Load a DEM tile from disk. Returns null if missing. */
export async function loadDem(path = DEFAULT_PATH) {
  let buf;
  try {
    buf = await readFile(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'DEM1') {
    throw new Error(`DEM: bad magic in ${path}`);
  }
  const width = buf.readUInt16LE(4);
  const height = buf.readUInt16LE(6);
  const cellSizeM = buf.readDoubleLE(8);
  const eastingMin = buf.readDoubleLE(16);
  const northingMax = buf.readDoubleLE(24);
  if (buf.length < 32 + width * height * 2) {
    throw new Error(`DEM: truncated body in ${path}`);
  }
  // Slice keeps the underlying ArrayBuffer reference cheap; values are stored
  // as deci-metres (uint16) so the runtime read multiplies by 0.1.
  const cells = new Uint16Array(buf.buffer, buf.byteOffset + 32, width * height);
  return {
    path,
    width,
    height,
    cellSizeM,
    eastingMin,
    northingMax, // top-left origin: row 0 corresponds to N = northingMax
    cells,
    source: 'EA LIDAR Composite DTM 1 m (downsampled)'
  };
}

// ---------- WGS84 → OSGB36 → BNG, mirrors scripts/fetch-dem.mjs ----------
// Accurate to a few metres across SE England; enough to index a 5 m grid.

const AIRY_A = 6377563.396;
const AIRY_B = 6356256.909;
const WGS_A = 6378137;
const WGS_B = 6356752.314245;
const F0 = 0.9996012717;
const LAT0 = (49 * Math.PI) / 180;
const LON0 = (-2 * Math.PI) / 180;
const N0 = -100000;
const E0 = 400000;

export function wgs84ToBng(lat, lon) {
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  const eW2 = 1 - (WGS_B * WGS_B) / (WGS_A * WGS_A);
  const nuW = WGS_A / Math.sqrt(1 - eW2 * Math.sin(phi) ** 2);
  const x1 = nuW * Math.cos(phi) * Math.cos(lam);
  const y1 = nuW * Math.cos(phi) * Math.sin(lam);
  const z1 = (1 - eW2) * nuW * Math.sin(phi);

  // Helmert WGS84 → OSGB36.
  const dx = -446.448, dy = 125.157, dz = -542.060;
  const rx = (-0.1502 / 3600) * (Math.PI / 180);
  const ry = (-0.247 / 3600) * (Math.PI / 180);
  const rz = (-0.8421 / 3600) * (Math.PI / 180);
  const s = -20.4894e-6;
  const x2 = dx + (1 + s) * x1 + -rz * y1 + ry * z1;
  const y2 = dy + rz * x1 + (1 + s) * y1 + -rx * z1;
  const z2 = dz + -ry * x1 + rx * y1 + (1 + s) * z1;

  const p = Math.hypot(x2, y2);
  const e2 = 1 - (AIRY_B * AIRY_B) / (AIRY_A * AIRY_A);
  let phi2 = Math.atan2(z2, p * (1 - e2));
  for (let i = 0; i < 8; i++) {
    const nu = AIRY_A / Math.sqrt(1 - e2 * Math.sin(phi2) ** 2);
    phi2 = Math.atan2(z2 + e2 * nu * Math.sin(phi2), p);
  }
  const lam2 = Math.atan2(y2, x2);

  const n = (AIRY_A - AIRY_B) / (AIRY_A + AIRY_B);
  const sin = Math.sin(phi2);
  const cos = Math.cos(phi2);
  const nu = (AIRY_A * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (AIRY_A * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;

  const Ma = (1 + n + (5 / 4) * n * n + (5 / 4) * n * n * n) * (phi2 - LAT0);
  const Mb = (3 * n + 3 * n * n + (21 / 8) * n * n * n) * Math.sin(phi2 - LAT0) * Math.cos(phi2 + LAT0);
  const Mc = ((15 / 8) * n * n + (15 / 8) * n * n * n) * Math.sin(2 * (phi2 - LAT0)) * Math.cos(2 * (phi2 + LAT0));
  const Md = ((35 / 24) * n * n * n) * Math.sin(3 * (phi2 - LAT0)) * Math.cos(3 * (phi2 + LAT0));
  const M = AIRY_B * F0 * (Ma - Mb + Mc - Md);

  const I = M + N0;
  const II = (nu / 2) * sin * cos;
  const III = (nu / 24) * sin * cos ** 3 * (5 - Math.tan(phi2) ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sin * cos ** 5 * (61 - 58 * Math.tan(phi2) ** 2 + Math.tan(phi2) ** 4);
  const IV = nu * cos;
  const V = (nu / 6) * cos ** 3 * (nu / rho - Math.tan(phi2) ** 2);
  const VI =
    (nu / 120) *
    cos ** 5 *
    (5 - 18 * Math.tan(phi2) ** 2 + Math.tan(phi2) ** 4 + 14 * eta2 - 58 * eta2 * Math.tan(phi2) ** 2);

  const dLam = lam2 - LON0;
  return {
    n: I + II * dLam ** 2 + III * dLam ** 4 + IIIA * dLam ** 6,
    e: E0 + IV * dLam + V * dLam ** 3 + VI * dLam ** 5
  };
}

/**
 * Bilinear-interpolated ground elevation (m) at (lat, lon), or null if the
 * point lies outside the loaded tile or on a no-data cell.
 */
export function elevationAt(dem, lat, lon) {
  if (!dem) return null;
  const { e, n } = wgs84ToBng(lat, lon);
  const col = (e - dem.eastingMin) / dem.cellSizeM;
  const row = (dem.northingMax - n) / dem.cellSizeM;
  if (col < 0 || row < 0 || col > dem.width - 1 || row > dem.height - 1) return null;

  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = Math.min(c0 + 1, dem.width - 1);
  const r1 = Math.min(r0 + 1, dem.height - 1);
  const fx = col - c0;
  const fy = row - r0;

  const z = (r, c) => {
    const v = dem.cells[r * dem.width + c];
    return v === NO_DATA ? null : v * 0.1;
  };
  const z00 = z(r0, c0);
  const z10 = z(r0, c1);
  const z01 = z(r1, c0);
  const z11 = z(r1, c1);

  // If any corner is no-data, fall back to nearest valid corner.
  const vals = [z00, z10, z01, z11];
  if (vals.some((v) => v == null)) {
    const valid = vals.filter((v) => v != null);
    if (valid.length === 0) return null;
    return valid.reduce((s, v) => s + v, 0) / valid.length;
  }
  return (
    z00 * (1 - fx) * (1 - fy) +
    z10 * fx * (1 - fy) +
    z01 * (1 - fx) * fy +
    z11 * fx * fy
  );
}
