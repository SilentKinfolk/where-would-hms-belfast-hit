# TODO

## Open questions
- **Confirm the gun laying in person.** Bearing (~318°) and elevation (~24.9°)
  are derived from the satellite — not measured on board. The app presents them
  as fact with a small "to confirm" note. May shift to "as it literally sits"
  once known. `fireAtAngles()` already supports explicit laying.
- **Real dispersion records** to replace the probable-error estimates
  (currently tuned to a single 700 yd Town-class anecdote).

## Modelling
- Finer met resolution: add 975/950/900/800/500 hPa Open-Meteo pressure levels,
  shrink downrange wind bands below 1.5 km.
- Density aloft from measured upper-air temperatures, not ICAO lapse off the
  surface.
- "As it literally sits" mode using the museum barrel angles.
- Per-turret / salvo patterns.

## Site
- Shareable links (URL-encode conditions).
- Wire the Claude vision describer (`server/describe.mjs`) into
  `scripts/log-impact.mjs` so the cron pre-renders the AI one-liner into each
  `latest` entry. Fixed cost (~$6/mo with Haiku 4.5), decoupled from traffic.
  `ANTHROPIC_API_KEY` goes in GH Actions secrets.

