# TODO

This models a single shell, not a salvo: where would one shell really land. The
physics is real; the two biggest unknowns are inputs that need real-world data,
not better code.

## Real data to gather
- **The gun laying, measured on the ship.** Bearing (~318°) and elevation
  (~24.9°) are derived from satellite imagery and solved to hit the target under
  standard air, not read off the mounting. Elevation is the load-bearing one: the
  impact moves ~340 m per degree, so a real "as it sits" answer needs the barrel
  angle and bearing measured at the museum. `fireAtAngles()` already takes an
  explicit laying. Until then the landing point could be off by hundreds of
  metres to kilometres, and the displayed laying is a working assumption.
- **A real range table for the 6"/50 Mk XXIII.** The drag curve, spin drift and
  round-to-round dispersion are fitted or estimated (dispersion is a rough
  figure, not from records). An official RN range table (BR.224 at TNA Kew or the
  IWM library) would give a measured drift column and real probable errors to
  replace them, and pin the muzzle-velocity PE that currently sets most of the
  CEP.

## Smaller open items
- The single-shell landing zone does not yet include uncertainty from the assumed
  laying or the spin-drift model. Once the real laying is measured, fold its
  residual uncertainty into the zone.
