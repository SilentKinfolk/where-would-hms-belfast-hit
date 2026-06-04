# Simulation fidelity review

_2026-06-04. Multi-agent review of the ballistics sim (atmosphere, wind, dispersion/CEP, drag/projectile, numerics, data-sourcing lenses). Every suggestion was re-checked against the actual code before it landed here: 9 material findings, 21 minor, 4 thrown out as misreads or already-done (including a "replace tuned PEs with range-table zones" idea that misread the existing tuning). The scratch probe scripts beside this file stay untracked._

The useful framing: the sim cleanly separates *where the shell lands* from *how big the CEP is*, and almost nothing in the dispersion budget actually moves the dot. So the levers fall into two piles.

## Moves where the shell lands (deterministic, highest value)

**1. The assumed laying dominates everything else put together.** Elevation is solved-to-hit (24.91°), so the standard-atmosphere miss is ~0 by construction. If the preserved mount actually sits at a low display elevation, the real fall of shot is 1.8 to 11 km short and may not reach the M1 at all (~336 m per degree). This is TODO #1 already, but worth saying plainly: it isn't a tweak, it's potentially the single largest correction in the model. Azimuth is fine (bearing-to-target is reasonable); the elevation is the load-bearing unknown.

**2. Spin drift (~97 m of the lateral miss) rests entirely on the Litz small-arms formula** extrapolated 15-20x past the time-of-flight it was fitted for. Shell length is the sensitive input: 24 vs 30 inches swings the drift 117 to 84 m. A real BR.224 drift column would validate it or move it ±20-35 m. Same archive as the dispersion-records TODO.

**3. The magazine-temperature proxy** (28-100 cm soil temp) plausibly differs from true Thames water temp by 2-4°C seasonally, which is ~40-80 m of unhedged range bias at 20.5 m/°C. A real water-temperature reading removes it.

## Fixes the CEP (the dot doesn't move, the uncertainty gets honest)

**4. The deflection laying PE (1.0 mil) is treated as round-to-round scatter,** but a lateral laying error is a systematic per-salvo shift, not per-shot spread. That's exactly why the ellipse looks too round. Dropping the round-to-round part to ~0.3 mil takes the reported deflection PE from 18 m to ~5 m and the ellipse semi-minor from 32 m to ~10 m, giving the correct long-and-narrow naval pattern. Clean and small.

**5. The MV probable error (3.0 m/s) is basically the entire CEP.** It supplies 114 of the 118 m range sigma and 51 of the 84 m gun CEP, and the comment admits it was back-fitted to one 700-yard anecdote through that one knob. Re-anchoring to a citable per-round figure (~0.2% = 1.65 m/s) drops the gun CEP to ~55 m, and more importantly turns the CEP from a number fitted to itself into a forward prediction.

**6. There's no pattern-centre (aim-point) uncertainty at all.** Met-centre uncertainty is folded in, but the assumed-laying tolerance (±0.1-0.2° → 34-67 m) and the spin-drift model error aren't. They're bias terms, so the right treatment is a separate "aim point vs mean point of impact" band, not inflating the round-to-round CEP.

**7. The propellant temp-sensitivity central value is modelled, but its uncertainty isn't.** Carrying a 0.6-1.0 m/s/°C band is ~0 in summer and +20-40% on the range CEP at a cold winter magazine.

## Cheap correctness / cosmetic

- `shellWeightPE_kg` is dead code: contributes exactly 0 m and burns 2 of the 6 engine fires per dispersion call. Either wire in the MV/BC coupling it implies, or drop it.
- Density is sampled uniformly along range instead of weighted by drag impulse (ρv²): a ~3-9 m one-way bias on non-ICAO days.
- The met finite-differences are one-sided (wind dir +10°, etc.); central differencing is sub-metre but cheap correctness insurance.
- One stale docstring: `weather.js` ~line 372 says humidity aloft isn't modelled (it is, via the obs-mean density fit). (The 2758-vs-2700 fps NOTE in belfast.js was double-checked against the NavWeaps page header — "Range ... for MV = 2,700 fps (823 mps)" — and is correct, not a mislabel.)
- Displayed terminal stats (ToF, striking velocity, angle of fall) carry a few-percent G7-shape bias vs NavWeaps. Cosmetic, doesn't touch the impact point.

## Checked and genuinely fine (don't chase these)

RK4 step, the curvature parabola, DEM convergence, flat-plane impact, 750 m wind banding, linear-vs-spline impact interpolation (~0.05 m), the `directionFrom` tailwind convention, gust handling, transonic and speed-of-sound effects (all sub-metre). The wind-on-range aerodynamic jump is genuinely missing but worth only 1-7 m.

## Suggested order of work

1. Quick code-level set, no new data needed: deflection-PE split (#4), remove the dead weight term, central differencing, the two stale docstrings. Keep the dispersion PEs documented rather than silently retuned.
2. Framing calls to confirm first: MV re-anchor (#5), the missing aim-point band (#6).
3. Needs real-world numbers (already earmarked): confirm the laying (#1), BR.224 drift column (#2), Thames water temp (#3).
