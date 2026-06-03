// One-shot DEM tile fetch. Downloads a small EA LIDAR Composite DTM (1 m)
// clip covering the impact ellipse around London Gateway services, downsamples
// to 5 m, and writes a compact binary at public/dem/london-gateway.bin that
// the cron loads at runtime (no GeoTIFF parser needed in production).
//
//   node scripts/fetch-dem.mjs
//
// Re-run if the target ever moves or you want a different resolution. The
// committed file is the source of truth — the cron never touches the WCS.
//
// Binary format (little-endian) — see src/dem.js loadDem for the reader:
//   bytes 0..3    ASCII magic "DEM1"
//   bytes 4..5    uint16 width   (columns)
//   bytes 6..7    uint16 height  (rows)
//   bytes 8..15   float64 cellSizeM    (grid spacing in metres)
//   bytes 16..23  float64 eastingMin   (BNG easting of column 0)
//   bytes 24..31  float64 northingMax  (BNG northing of row 0; top-left origin, row 0 = north)
//   bytes 32..    uint16[width * height] elevation in deci-metres (value * 0.1 = m AOD),
//                 row-major; 0xffff marks no-data

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { fromArrayBuffer } from 'geotiff';

import { TARGET } from '../src/data/belfast.js';

// Half-width of the bounding box around the target (in metres BNG). The CEP
// ellipse is roughly 200 m long × 80 m wide; 1 km half-width gives plenty of
// margin if the impact shifts under wild weather, plus room to walk the
// descending arc.
const HALF_M = 1000;
const TARGET_CELL_M = 5; // downsample target

const WCS_BASE =
  'https://environment.data.gov.uk/spatialdata/' +
  'lidar-composite-digital-terrain-model-dtm-1m/wcs';
const COVERAGE_ID =
  '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m';

const OUT_PATH = fileURLToPath(new URL('../public/dem/london-gateway.bin', import.meta.url));

// WGS84 → OSGB36 → BNG conversion. The full transform is iterative; for a
// point in SE England the OSGB36 / WGS84 offset is ~5 m N, ~90 m E and the
// projection itself is the dominant term. We use Helmert + transverse Mercator
// from the OS guidance, accurate to a few metres — fine for picking a tile.
function wgs84ToBng(lat, lon) {
  // OSGB36 ellipsoid (Airy 1830) and projection params.
  const a = 6377563.396; // Airy semi-major
  const b = 6356256.909; // Airy semi-minor
  const F0 = 0.9996012717; // central scale
  const lat0 = (49 * Math.PI) / 180; // true origin lat
  const lon0 = (-2 * Math.PI) / 180; // true origin lon
  const N0 = -100000; // northing of true origin
  const E0 = 400000; // easting of true origin

  // First, a small Helmert transform from WGS84 to OSGB36 (negligible to ~5 m).
  const dx = -446.448, dy = 125.157, dz = -542.060;
  const rx = (-0.1502 / 3600) * (Math.PI / 180);
  const ry = (-0.247 / 3600) * (Math.PI / 180);
  const rz = (-0.8421 / 3600) * (Math.PI / 180);
  const s = -20.4894e-6;

  // WGS84 ellipsoid for the source.
  const aW = 6378137;
  const bW = 6356752.314245;
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  const eW2 = 1 - (bW * bW) / (aW * aW);
  const nuW = aW / Math.sqrt(1 - eW2 * Math.sin(phi) ** 2);
  const x1 = (nuW + 0) * Math.cos(phi) * Math.cos(lam);
  const y1 = (nuW + 0) * Math.cos(phi) * Math.sin(lam);
  const z1 = ((1 - eW2) * nuW + 0) * Math.sin(phi);
  // Apply Helmert.
  const x2 = dx + (1 + s) * x1 + -rz * y1 + ry * z1;
  const y2 = dy + rz * x1 + (1 + s) * y1 + -rx * z1;
  const z2 = dz + -ry * x1 + rx * y1 + (1 + s) * z1;
  // Convert back to lat/lon on OSGB36 (iterative).
  const p = Math.hypot(x2, y2);
  const e2 = 1 - (b * b) / (a * a);
  let phi2 = Math.atan2(z2, p * (1 - e2));
  for (let i = 0; i < 8; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(phi2) ** 2);
    phi2 = Math.atan2(z2 + e2 * nu * Math.sin(phi2), p);
  }
  const lam2 = Math.atan2(y2, x2);

  // OSGB36 transverse Mercator.
  const n = (a - b) / (a + b);
  const sin = Math.sin(phi2);
  const cos = Math.cos(phi2);
  const nu = a * F0 / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;

  const Ma =
    (1 + n + (5 / 4) * n * n + (5 / 4) * n * n * n) * (phi2 - lat0);
  const Mb =
    (3 * n + 3 * n * n + (21 / 8) * n * n * n) *
    Math.sin(phi2 - lat0) *
    Math.cos(phi2 + lat0);
  const Mc =
    ((15 / 8) * n * n + (15 / 8) * n * n * n) *
    Math.sin(2 * (phi2 - lat0)) *
    Math.cos(2 * (phi2 + lat0));
  const Md =
    (35 / 24) * n * n * n *
    Math.sin(3 * (phi2 - lat0)) *
    Math.cos(3 * (phi2 + lat0));
  const M = b * F0 * (Ma - Mb + Mc - Md);

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

  const dLam = lam2 - lon0;
  const N = I + II * dLam ** 2 + III * dLam ** 4 + IIIA * dLam ** 6;
  const E = E0 + IV * dLam + V * dLam ** 3 + VI * dLam ** 5;
  return { e: E, n: N };
}

const { e: tgtE, n: tgtN } = wgs84ToBng(TARGET.position.lat, TARGET.position.lon);
console.log(`Target BNG: E=${tgtE.toFixed(1)} N=${tgtN.toFixed(1)}`);
const eMin = Math.round(tgtE - HALF_M);
const eMax = Math.round(tgtE + HALF_M);
const nMin = Math.round(tgtN - HALF_M);
const nMax = Math.round(tgtN + HALF_M);

const url =
  `${WCS_BASE}?service=WCS&version=2.0.1&request=GetCoverage` +
  `&coverageId=${COVERAGE_ID}` +
  `&subset=E(${eMin},${eMax})` +
  `&subset=N(${nMin},${nMax})` +
  `&format=image/tiff` +
  `&subsettingcrs=http://www.opengis.net/def/crs/EPSG/0/27700`;

console.log(`Fetching DEM clip from EA WCS…\n  ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const buf = await res.arrayBuffer();
console.log(`Got ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB GeoTIFF.`);

const tiff = await fromArrayBuffer(buf);
const image = await tiff.getImage();
const srcWidth = image.getWidth();
const srcHeight = image.getHeight();
const [resX, resY] = image.getResolution(); // geotiff returns POSITIVE pixel size
const rasters = await image.readRasters();
const src = rasters[0]; // Float32Array

// Source bbox in image CRS (EPSG:27700) — getBoundingBox handles axis direction,
// which the raw origin+resolution does not. Returns [Emin, Nmin, Emax, Nmax].
const [srcEMin, srcNMin, srcEMax, srcNMax] = image.getBoundingBox();
// Row 0 of the raster sits at the top of the bbox (highest N). Use that when
// reading values back out below.
const cellM = Math.abs(resY);
console.log(
  `Source: ${srcWidth}×${srcHeight} px, ` +
    `E ${srcEMin.toFixed(1)}..${srcEMax.toFixed(1)}, ` +
    `N ${srcNMin.toFixed(1)}..${srcNMax.toFixed(1)}, ` +
    `cell ≈ ${cellM.toFixed(2)} m`
);

// Downsample factor (rounded so cell ≈ TARGET_CELL_M).
const factor = Math.max(1, Math.round(TARGET_CELL_M / cellM));
const dstWidth = Math.floor(srcWidth / factor);
const dstHeight = Math.floor(srcHeight / factor);
const dst = new Float32Array(dstWidth * dstHeight);
// EA range constraint says valid elevations live in [-12, 1400] m; anything
// outside that (Float32 sentinels, ±Inf, NaN) is no-data.
const isValid = (v) => Number.isFinite(v) && v >= -50 && v <= 1500;
for (let dy = 0; dy < dstHeight; dy++) {
  for (let dx = 0; dx < dstWidth; dx++) {
    let sum = 0;
    let n = 0;
    for (let oy = 0; oy < factor; oy++) {
      for (let ox = 0; ox < factor; ox++) {
        const sx = dx * factor + ox;
        const sy = dy * factor + oy;
        if (sx >= srcWidth || sy >= srcHeight) continue;
        const v = src[sy * srcWidth + sx];
        if (!isValid(v)) continue;
        sum += v;
        n++;
      }
    }
    dst[dy * dstWidth + dx] = n > 0 ? sum / n : NaN;
  }
}

let mn = Infinity;
let mx = -Infinity;
let filled = 0;
for (const v of dst) {
  if (!Number.isFinite(v)) continue;
  if (v < mn) mn = v;
  if (v > mx) mx = v;
  filled++;
}
console.log(
  `Downsampled to ${dstWidth}×${dstHeight} (factor ${factor}). ` +
    `Elevation ${mn.toFixed(1)}..${mx.toFixed(1)} m, filled ${filled}/${dst.length}.`
);

// Quantise to deci-metres (0.1 m steps); reserve 0xFFFF as no-data.
const NO_DATA = 0xffff;
const out = new Uint16Array(dstWidth * dstHeight);
for (let i = 0; i < dst.length; i++) {
  if (!Number.isFinite(dst[i])) {
    out[i] = NO_DATA;
    continue;
  }
  const decim = Math.round(dst[i] * 10); // 0.1 m units
  out[i] = Math.max(0, Math.min(0xfffe, decim));
}

const dstCellM = cellM * factor;
const dstEMax = srcEMin + dstCellM * dstWidth;
const dstNMin = srcNMax - dstCellM * dstHeight;

// Binary layout (little-endian):
//   bytes 0..3   "DEM1" magic
//   bytes 4..5   uint16 width   (cells along Easting)
//   bytes 6..7   uint16 height  (cells along Northing, top-down)
//   bytes 8..15  float64 cellSizeM
//   bytes 16..23 float64 eastingMin  (BNG metres)
//   bytes 24..31 float64 northingMax (BNG metres; top-left origin)
// Then width*height uint16 elevationDeciM (0xFFFF = no-data).
const HEADER = 32;
const buffer = Buffer.alloc(HEADER + out.length * 2);
buffer.write('DEM1', 0, 'ascii');
buffer.writeUInt16LE(dstWidth, 4);
buffer.writeUInt16LE(dstHeight, 6);
buffer.writeDoubleLE(dstCellM, 8);
buffer.writeDoubleLE(srcEMin, 16);
buffer.writeDoubleLE(srcNMax, 24);
for (let i = 0; i < out.length; i++) {
  buffer.writeUInt16LE(out[i], HEADER + i * 2);
}

await mkdir(fileURLToPath(new URL('../public/dem/', import.meta.url)), { recursive: true });
await writeFile(OUT_PATH, buffer);
console.log(
  `Wrote ${OUT_PATH} ` +
    `(${(buffer.byteLength / 1024).toFixed(1)} KB; ` +
    `BNG E ${srcEMin.toFixed(0)}..${dstEMax.toFixed(0)}, N ${dstNMin.toFixed(0)}..${srcNMax.toFixed(0)}).`
);
