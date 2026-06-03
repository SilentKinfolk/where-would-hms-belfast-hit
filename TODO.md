# TODO

## Open questions
- **Confirm the gun laying in person.** Bearing (~318°) and elevation (~24.9°)
  are derived from the satellite — not measured on board. The app presents them
  as fact with a small "to confirm" note. May shift to "as it literally sits"
  once known. `fireAtAngles()` already supports explicit laying.
- **Real RN dispersion records** to replace the probable-error estimates
  (currently tuned to a single 700 yd Town-class anecdote). Same source would
  give real drift figures for the 6"/50 Mk XXIII. BR.224 range tables at TNA
  Kew or the IWM library would do it.

## In progress
- **Humidity aloft.** Currently surface only; Open-Meteo serves
  `relative_humidity_{L}hPa`. Threads through `effectiveSurfaceTempC` for a
  small density correction.
- **Wind gust factor.** Use `wind_gusts_10m`; fold into the wind-speed sigma in
  `metUncertaintySigmas()` instead of the fixed 2 m/s estimate.
- **Powder temperature.** js-ballistics has native `Ammo.powderTemp` +
  `tempModifier` + `usePowderSensitivity`. Reference 26.7 °C (80 °F RN cordite
  SC nominal), sensitivity ~0.8 m/s per °C. Magazine temp = Open-Meteo
  `soil_temperature_28_to_100cm` as a thermal-mass proxy for the hull's
  interior (Thames water temp not freely API'd; soil-at-1m has the right time
  constant). Residual proxy error is below the round-to-round MV PE noise floor.
- **Shell-weight PE.** RN graded shells into bands of ~±1 lb. Add a third
  range-sigma contribution alongside MV PE and elevation laying PE.
- **Forecast ensemble spread.** Replace `FORECAST_UNCERTAINTY` estimates
  (±2 m/s, ±15°, ±2 °C) with Open-Meteo Ensemble API stddev across members.
- **DEM-aware impact.** EA LIDAR Composite DTM (1 m, free OGL) tile bundled in
  `public/dem/`. Server-side intersection along the descending arc finds the
  true ground impact, not a single nominal elevation.
- **OS Maps basemap.** Switch from OSM to OS Maps API "Light" style + CSS
  grayscale filter. Needs `VITE_OS_API_KEY` (free OS Data Hub signup, set as
  GH Pages secret + injected at build). Domain-restrict the key in the OS
  console so a leaked client-side key can't be abused.
- **Open Graph image.** Bake a 1200×630 share card at cron time alongside the
  AI-describer render. Plus `og:title` / `og:description` / `og:image` meta
  in `index.html` so links unfurl with the latest answer.

## Modelling — done
See README and STATUS. Drag, Coriolis, spin drift, Earth curvature, winds aloft,
density via effective surface T, tide-aware muzzle, CEP with gun + forecast
components.

## Modelling — not planned
- **5-DOF / Modified Point Mass** (aerodynamic jump, yaw of repose, Magnus).
  js-ballistics is point-mass only. Effects are absorbed into PE.
- **Stratified atmosphere.** js-ballistics' `Atmo` is single-point ICAO. The
  current `effectiveSurfaceTempC` fit reproduces observed mean density along
  the trajectory — equivalent for ~3 km apogee.
- **Per-tube calibrated MV / tube wear.** Belfast hasn't fired since the late
  1950s; service-life MV (823 m/s vs 841 m/s new-gun) is the right de-rated
  number. Live tube wear is not applicable to a preserved museum gun.

## UX — not planned (parked for later)
- Permalink to a specific past tick (`?t=ISO`).
- Trajectory arc visualisation (side view).
- Wind-profile widget (vertical chart at apogee).
- AI description on ghost popups.
- 30-day stats line / closest-shot leaderboard.
- "Days since on target" counter.
