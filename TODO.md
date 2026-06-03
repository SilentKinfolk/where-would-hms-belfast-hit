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

## Modelling — done
Drag, Coriolis, spin drift, Earth curvature, winds aloft (with humidity), air
density via the effective surface T fit, tide-aware muzzle, powder/magazine
temperature (Cordite SC sensitivity, magazine temp = Open-Meteo
`soil_temperature_28_to_100cm` thermal-mass proxy), shell-weight PE,
DEM-aware ground intersection (EA LIDAR Composite DTM 1 m, downsampled to
5 m, bundled at `public/dem/`), CEP combining gun dispersion with real
ICON-EPS forecast spread + wind-gust margin.

## UX — done
B&W single-serving-site layout, AI vision describer (Claude Sonnet 4.6 reading
the rendered impact map), ghost trail of past calculations, Storm Éowyn replay,
GoatCounter visit counter, OG share card regenerated each cron tick (1200×630
greyscale, scoped to the CEP) — meta tags point at the raw URL so unfurls
always see the latest without a Pages redeploy.

## Modelling — not planned
- **5-DOF / Modified Point Mass** (aerodynamic jump, yaw of repose, Magnus).
  js-ballistics is point-mass only. Effects are absorbed into PE.
- **Stratified atmosphere.** js-ballistics' `Atmo` is single-point ICAO. The
  current `effectiveSurfaceTempC` fit reproduces observed mean density along
  the trajectory — equivalent for ~3 km apogee.
- **Per-tube calibrated MV / tube wear.** Belfast hasn't fired since the late
  1950s; service-life MV (823 m/s vs 841 m/s new-gun) is the right de-rated
  number. Live tube wear is not applicable to a preserved museum gun.
- **OS Maps basemap.** Tried OS Maps API "Light" + greyscale filter; looked
  worse than OSM-with-filter in practice, so reverted. The plumbing path
  (VITE_OS_API_KEY at build, OS Data Hub key + domain restriction) is
  documented in git history if anyone wants to retry with a different style.

## UX — not planned (parked for later)
- Permalink to a specific past tick (`?t=ISO`).
- Trajectory arc visualisation (side view).
- Wind-profile widget (vertical chart at apogee).
- AI description on ghost popups.
- 30-day stats line / closest-shot leaderboard.
- "Days since on target" counter.
