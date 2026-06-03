// Human-readable description of where the shell lands, via OpenStreetMap's
// Nominatim reverse geocoder (keyless, CORS-enabled). Best-effort: returns a
// punchy place label or null. Results are cached by rounded coordinate, and we
// stay well under Nominatim's 1 req/s usage policy (we call it per recompute).

const cache = new Map();

export async function describeImpact(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);

  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}` +
    `&format=jsonv2&zoom=18&addressdetails=1`;

  let result = null;
  try {
    const res = await fetch(url);
    if (res.ok) result = buildLabel(await res.json());
  } catch {
    /* offline / blocked — leave null, UI falls back to coordinates */
  }
  cache.set(key, result);
  return result;
}

function buildLabel(d) {
  const a = d.address || {};
  const place =
    (d.name && d.name.trim()) ||
    a.road ||
    a.pedestrian ||
    a.footway ||
    a.neighbourhood ||
    a.suburb ||
    a.hamlet ||
    a.village;
  if (!place) return null;

  const locality =
    a.suburb || a.neighbourhood || a.town || a.village || a.city_district || a.city || '';

  return {
    place,
    locality: locality && locality !== place ? locality : '',
    type: d.type || '',
    category: d.category || ''
  };
}
