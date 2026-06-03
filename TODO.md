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

### Claude vision describer — wire into the cron
Pre-render the AI one-liner once per 30-min tick and store it in `latest`, so
every visitor sees it without any per-visit API call.

Plumbing already in place:
- `server/describe.mjs` exports `renderCepMap(center, ellipse)` → PNG and
  `describeCep(pngBuffer)` → string. Both safe to import (the HTTP server only
  starts when the file is run directly).
- `src/main.js` already reads `result.place` / `result.description` from each
  entry and falls back to client-side Nominatim if either is missing.

Steps:
1. In `scripts/log-impact.mjs`, after `computeImpact(...)`:
   - Build the ellipse ring via `destinationPoint` (see `src/describe-ai.js` for
     the existing client-side recipe; reuse the same shape).
   - Call `renderCepMap({lat,lon}, ring)` → PNG buffer.
   - Call `describeCep(buffer)` → one-line string. Set `result.description`.
   - Reverse-geocode via Nominatim (mirror `src/describe.js`) — **server-side
     calls MUST set a `User-Agent` header**, otherwise Nominatim returns null.
     Set `result.place`.
2. Add `ANTHROPIC_API_KEY` to GH Actions repo secrets, expose to the workflow
   via `env`. Default `DESCRIBE_MODEL` to `claude-haiku-4-5` for cost (~$6/mo);
   Opus 4.8 is only worth the upgrade if Haiku's map-reading isn't crisp.
3. Skip the AI call if it fails (cron should still commit the entry without it
   — the geocode fallback in `main.js` will kick in).
4. Optional cleanup after it's live:
   - `src/describe-ai.js` (the client-side proxy call) is no longer reached
     from `main.js` — safe to delete.
   - `npm run proxy` + `vite.config.js`'s `/api` route + `package.json`'s
     `@anthropic-ai/sdk` + `staticmaps` deps stay on if you still want the
     local proxy for testing; otherwise drop them.
5. Also extend `scripts/precompute-storm.mjs` to do the same call once, so
   `?storm` gets the AI line too.

Costs at the chosen 30-min cadence: 48 calls/day, ~$0.004/call with Haiku 4.5
→ roughly $6/month, traffic-independent.

Use the `claude-api` skill when writing the call — it knows how to set up
prompt caching for the system block (the prompt is static across runs, so
caching is real money saved).

