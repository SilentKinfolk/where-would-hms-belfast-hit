// Live weather from Open-Meteo (free, keyless, CORS-enabled).
// Returns current surface conditions plus a winds-aloft profile (wind vs
// geopotential altitude) covering the shell's ~3 km climb.

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ELEVATION = 'https://api.open-meteo.com/v1/elevation';

// Pressure levels from the surface up past the shell's apogee (~3.2 km → ~700 hPa).
const LEVELS = [1000, 925, 850, 700, 600];

const DEG = Math.PI / 180;

/** Fetch current conditions + winds-aloft profile for a point. */
export async function fetchWeather(lat, lon) {
  const hourly = LEVELS.flatMap((L) => [
    `wind_speed_${L}hPa`,
    `wind_direction_${L}hPa`,
    `geopotential_height_${L}hPa`
  ]).join(',');

  const url =
    `${FORECAST}?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m` +
    `&hourly=${hourly}&wind_speed_unit=ms&timezone=GMT&forecast_days=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo forecast HTTP ${res.status}`);
  const d = await res.json();
  const c = d.current;
  const groundElevM = d.elevation ?? 0;

  // Index of the hourly slot matching the current hour.
  const hourKey = c.time.slice(0, 13);
  let idx = d.hourly.time.findIndex((t) => t.slice(0, 13) === hourKey);
  if (idx < 0) idx = 0;

  // Wind profile: surface (10 m AGL) plus each pressure level, by altitude.
  const profile = [
    {
      altitudeM: groundElevM + 10,
      speedMs: c.wind_speed_10m,
      dirFromDeg: c.wind_direction_10m
    }
  ];
  for (const L of LEVELS) {
    const gph = d.hourly[`geopotential_height_${L}hPa`]?.[idx];
    const ws = d.hourly[`wind_speed_${L}hPa`]?.[idx];
    const wd = d.hourly[`wind_direction_${L}hPa`]?.[idx];
    if (gph == null || ws == null || wd == null) continue;
    if (gph <= groundElevM + 10) continue;
    profile.push({ altitudeM: gph, speedMs: ws, dirFromDeg: wd });
  }
  profile.sort((a, b) => a.altitudeM - b.altitudeM);

  return {
    surface: {
      tempC: c.temperature_2m,
      humidity: c.relative_humidity_2m / 100,
      pressureHpa: c.surface_pressure,
      windSpeedMs: c.wind_speed_10m,
      windDirDeg: c.wind_direction_10m,
      groundElevM
    },
    profile,
    obsTime: c.time, // surface observation time (UTC, ~15-min resolution)
    validTime: d.hourly.time[idx], // winds-aloft hourly slot (UTC)
    fetchedAt: Date.now(),
    source: 'Open-Meteo'
  };
}

// Historical "replay" weather (hidden mode). Open-Meteo's Historical Forecast
// API keeps the winds-aloft profile back to ~late 2024. Picks the given hour, or
// the windiest hour aloft that day. Same shape as fetchWeather().
const HISTORICAL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';

export async function fetchHistoricalWeather(lat, lon, date, hour) {
  const hourly = ['temperature_2m', 'relative_humidity_2m', 'surface_pressure', 'wind_speed_10m', 'wind_direction_10m']
    .concat(LEVELS.flatMap((L) => [`wind_speed_${L}hPa`, `wind_direction_${L}hPa`, `geopotential_height_${L}hPa`]))
    .join(',');
  const url =
    `${HISTORICAL}?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}` +
    `&hourly=${hourly}&wind_speed_unit=ms&timezone=GMT`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo historical HTTP ${res.status}`);
  const d = await res.json();
  const H = d.hourly;
  if (!H?.time?.length) throw new Error('No historical data for that date');
  const groundElevM = d.elevation ?? 0;

  // Pick the requested hour, else the hour with the strongest wind at 850 hPa.
  let idx;
  if (Number.isInteger(hour) && hour >= 0 && hour < H.time.length) {
    idx = hour;
  } else {
    idx = 0;
    for (let i = 1; i < H.time.length; i++) {
      if ((H.wind_speed_850hPa?.[i] ?? -1) > (H.wind_speed_850hPa?.[idx] ?? -1)) idx = i;
    }
  }

  const profile = [
    { altitudeM: groundElevM + 10, speedMs: H.wind_speed_10m[idx], dirFromDeg: H.wind_direction_10m[idx] }
  ];
  for (const L of LEVELS) {
    const gph = H[`geopotential_height_${L}hPa`]?.[idx];
    const ws = H[`wind_speed_${L}hPa`]?.[idx];
    const wd = H[`wind_direction_${L}hPa`]?.[idx];
    if (gph == null || ws == null || wd == null || gph <= groundElevM + 10) continue;
    profile.push({ altitudeM: gph, speedMs: ws, dirFromDeg: wd });
  }
  profile.sort((a, b) => a.altitudeM - b.altitudeM);

  return {
    surface: {
      tempC: H.temperature_2m[idx],
      humidity: H.relative_humidity_2m[idx] / 100,
      pressureHpa: H.surface_pressure[idx],
      windSpeedMs: H.wind_speed_10m[idx],
      windDirDeg: H.wind_direction_10m[idx],
      groundElevM
    },
    profile,
    obsTime: H.time[idx],
    validTime: H.time[idx],
    fetchedAt: Date.now(),
    source: 'Open-Meteo (historical)',
    historical: true,
    windsAloft: profile.length > 1
  };
}

// UK Environment Agency tidal gauge at Tower Pier (~280 m from Belfast). Open
// data, no key, CORS-enabled, 15-min readings in metres Above Ordnance Datum.
const EA_TOWER_PIER = 'https://environment.data.gov.uk/flood-monitoring/id/stations/0007';

/** Latest measured Thames tide level near the ship, or null on failure. */
export async function fetchTide() {
  const res = await fetch(EA_TOWER_PIER);
  if (!res.ok) throw new Error(`EA tide HTTP ${res.status}`);
  const d = await res.json();
  const measures = [].concat(d.items?.measures ?? []);
  const m = measures.find((x) => /tidal/i.test(x.qualifier || '')) ?? measures[0];
  const reading = m?.latestReading;
  if (!reading || typeof reading.value !== 'number') return null;
  return {
    levelMAOD: reading.value,
    dateTime: reading.dateTime,
    station: d.items?.label ?? 'Tower Pier'
  };
}

/** Ground elevations (m) for a list of {lat, lon} points, in order. */
export async function fetchElevations(points) {
  const lats = points.map((p) => p.lat).join(',');
  const lons = points.map((p) => p.lon).join(',');
  const res = await fetch(`${ELEVATION}?latitude=${lats}&longitude=${lons}`);
  if (!res.ok) throw new Error(`Open-Meteo elevation HTTP ${res.status}`);
  const d = await res.json();
  return d.elevation;
}

/**
 * Interpolate wind at a given altitude from the profile. Interpolates the wind
 * as a vector (so directions blend correctly through any compass wraparound).
 * Returns meteorological "from" direction in degrees.
 */
export function windAtAltitude(profile, altitudeM) {
  if (!profile.length) return { speedMs: 0, dirFromDeg: 0 };
  if (altitudeM <= profile[0].altitudeM) return profile[0];
  const last = profile[profile.length - 1];
  if (altitudeM >= last.altitudeM) return last;

  let i = 1;
  while (i < profile.length && altitudeM > profile[i].altitudeM) i++;
  const a = profile[i - 1];
  const b = profile[i];
  const f = (altitudeM - a.altitudeM) / (b.altitudeM - a.altitudeM);

  const ax = a.speedMs * Math.sin(a.dirFromDeg * DEG);
  const ay = a.speedMs * Math.cos(a.dirFromDeg * DEG);
  const bx = b.speedMs * Math.sin(b.dirFromDeg * DEG);
  const by = b.speedMs * Math.cos(b.dirFromDeg * DEG);
  const x = ax + (bx - ax) * f;
  const y = ay + (by - ay) * f;
  return {
    speedMs: Math.hypot(x, y),
    dirFromDeg: (Math.atan2(x, y) / DEG + 360) % 360
  };
}
