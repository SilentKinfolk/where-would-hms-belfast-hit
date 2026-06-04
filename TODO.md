# TODO

This models a single shell, not a salvo. The physics is real; the load-bearing
inputs aren't all measured. The gun laying, the range table, the shell's drag and
spin drift are estimates, not measurements. None of this needs better code, just
real-world data, a measurement, or someone who knows.

## Real data to gather

- **The barrel laying, measured on board.** Bearing (~318°) and elevation
  (~24.9°) are read off satellite imagery and solved to hit the target under
  standard air, rather than measured from the mounting. Elevation matters most:
  the impact moves ~340 m per degree, so a real "as it sits" answer needs the
  barrel angle and bearing measured at the museum. `fireAtAngles()` already takes
  an explicit laying. Until then the landing point could be off by hundreds of
  metres to kilometres, and the displayed laying is a working assumption. Ask the
  IWM curators on HMS Belfast.
- **A range table for the 6"/50 Mk XXIII.** Drag, drift and round-to-round
  dispersion are all fitted or estimated. The dispersion figure especially is a
  rough guess with no records behind it. An Admiralty range table (BR.224) lists
  measured range, drift, striking velocity and probable errors directly. That
  would replace the estimates and pin the muzzle-velocity PE that currently sets
  most of the CEP. Look in the National Archives (ADM series) at Kew or the IWM
  library, or ask a naval-gunnery historian.
- **The shell's real drag.** The drag curve is a borrowed rifle-bullet shape (G7)
  with one fitted coefficient. It reproduces the range table to ~1%, but the
  striking velocity and descent angle it reports run a couple of percent off. A
  measured curve would fix that: digitise a real 6-inch CPBC shell from drawings
  or a surviving round, build a model, and run CFD or get spark-range drag-vs-Mach
  data.
- **Spin drift.** The least trustworthy number on the map. The engine uses a
  small-arms formula stretched well past the flight time it was built for; the
  drift lands straight on the left/right deflection, and the range table can't
  check it. A real drift column, or a 4-DoF/6-DoF solver run with the shell's true
  mass and aero data, would validate or replace the ~100 m it currently gives.
- **Cordite SC temperature sensitivity.** Currently a generic ~0.8 m/s per °C. The
  real figure for this charge sits in Admiralty propellant records, or with an
  ordnance historian.
- **Shell length and centre of gravity.** The spin-drift calc assumes 27 inches;
  the shell's true length and CoG would replace that, from the original drawings.
  (Range-table MV is settled: the NavWeaps table is computed for 2,700 fps /
  823 m/s.)

## Smaller open items

- The single-shell landing zone doesn't yet include uncertainty from the assumed
  laying or the spin-drift model. Once the real laying is measured, fold its
  residual uncertainty into the zone.
