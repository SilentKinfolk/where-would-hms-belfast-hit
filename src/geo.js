// Geodesy helpers on a spherical Earth. Good to a few metres at these ranges,
// which is plenty for plotting fall of shot.
//
// All positions are { lat, lon } in decimal degrees. Distances are in metres,
// bearings in degrees clockwise from true north.

const R = 6371008.8; // mean Earth radius (m)
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance between two points, in metres. */
export function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial bearing from a to b, in degrees clockwise from true north. */
export function bearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Destination point from `start`, travelling `distance` m along `bearing` deg. */
export function destinationPoint(start, bearing, distance) {
  const d = distance / R;
  const brng = toRad(bearing);
  const lat1 = toRad(start.lat);
  const lon1 = toRad(start.lon);
  const sinLat2 =
    Math.sin(lat1) * Math.cos(d) +
    Math.cos(lat1) * Math.sin(d) * Math.cos(brng);
  const lat2 = Math.asin(sinLat2);
  const y = Math.sin(brng) * Math.sin(d) * Math.cos(lat1);
  const x = Math.cos(d) - Math.sin(lat1) * sinLat2;
  const lon2 = lon1 + Math.atan2(y, x);
  return {
    lat: toDeg(lat2),
    lon: (((toDeg(lon2) + 540) % 360) - 180)
  };
}

/** Convert a compass bearing to the nearest 16-point name (e.g. "NNW"). */
export function compassName(bearing) {
  const points = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'
  ];
  return points[Math.round(bearing / 22.5) % 16];
}
