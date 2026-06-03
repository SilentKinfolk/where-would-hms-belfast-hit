# TODO

## Open questions
- **Confirm the gun laying in person.** Bearing (~318°) and elevation (~24.9°)
  are derived from the satellite — not measured on board. The app presents them
  as fact with a small "to confirm" note. May shift to "as it literally sits"
  once known. `fireAtAngles()` already supports explicit laying.
- **Real dispersion records** to replace the probable-error estimates
  (currently tuned to a single 700 yd Town-class anecdote).

## Modelling
- "As it literally sits" mode using the museum barrel angles.
- Per-turret / salvo patterns.

## Cron / cost
- Reuse the previous tick's AI line when the new impact sits inside the last
  tick's CEP (or within ~100 m). The map a vision model would see is the same,
  so the line still describes it. Saves ~$0.004 per duplicate Haiku call.
  Keep the Nominatim place refresh either way (free, surfaces edge moves).

