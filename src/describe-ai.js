// Calls the optional /api/describe proxy (Claude vision over the CEP map) to get
// a casual one-line description of the impact area. Returns null if the proxy is
// unavailable, so the caller can fall back to the reverse-geocoded line.

import { destinationPoint } from './geo.js';

const cache = new Map(); // rounded "lat,lon" -> description

function ellipseRing(center, ellipse, steps = 40) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const along = destinationPoint(center, ellipse.orientationDeg, ellipse.semiMajorM * Math.cos(t));
    const p = destinationPoint(along, (ellipse.orientationDeg + 90) % 360, ellipse.semiMinorM * Math.sin(t));
    ring.push([p.lat, p.lon]);
  }
  return ring;
}

export async function describeImpactAI(result) {
  if (!result?.ellipse) return null;
  const center = { lat: result.impact.lat, lon: result.impact.lon };
  const key = `${center.lat.toFixed(4)},${center.lon.toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);

  const res = await fetch('/api/describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ center, ellipse: ellipseRing(center, result.ellipse) })
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.description) cache.set(key, data.description);
  return data?.description ?? null;
}
