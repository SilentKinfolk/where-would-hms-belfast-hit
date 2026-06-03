// Calibrate the drag model against the NavWeaps range table for the 6"/50 Mk XXIII.
// Table is quoted at MV = 2,700 fps (823 m/s). Run: node scripts/calibrate.mjs
import {
  Calculator, Shot, Weapon, Ammo, DragModel, DragTables,
  Atmo, UNew, Distance, Velocity, Angular, TrajFlag, IntegrationMethod
} from 'js-ballistics';

const MV = 823; // m/s — the MV the range table is computed for
// [elevation deg, range m, striking vel m/s, ToF s, angle of fall deg]
const TABLE = [
  [2.3, 4570, 591, 6.6, 3.0],
  [6.2, 9140, 418, 15.9, 10.0],
  [13.1, 13720, 335, 29.4, 23.6],
  [24.1, 18290, 331, 47.2, 39.9],
  [41.1, 22400, 353, 71.4, 56.5],
  [45.0, 23300, null, null, null],
];
const calc = new Calculator({ method: IntegrationMethod.RK4,
  config: { minimumVelocity: 0, minimumAltitude: -2000, maximumDrop: -500000 } });

function shot(bc, table, elevDeg) {
  const dm = new DragModel({ bc, dragTable: table, weight: UNew.Gram(50800), diameter: UNew.Inch(6.0) });
  return new Shot({ weapon: new Weapon({ sightHeight: UNew.Meter(0), zeroElevation: UNew.Degree(elevDeg) }),
    ammo: new Ammo({ dm, mv: UNew.MPS(MV) }), atmo: Atmo.standard() });
}
async function fire(bc, table, elevDeg) {
  const hit = await calc.fire({ shot: shot(bc, table, elevDeg), trajectoryRange: UNew.Meter(30000),
    trajectoryStep: UNew.Meter(5000), filterFlags: TrajFlag.ALL, raiseRangeError: false });
  const imp = hit.flag(TrajFlag.ZERO_DOWN) ?? hit.trajectory[hit.trajectory.length-1];
  return { range: imp.distance.In(Distance.Meter), tof: imp.time,
    sv: imp.velocity.In(Velocity.MPS), aof: Math.abs(imp.angle?.In(Angular.Degree) ?? 0) };
}
async function rmsErr(bc, table) { // RMS relative range error over rows
  let s = 0;
  for (const [el, rng] of TABLE) { const r = (await fire(bc, table, el)).range; s += ((r-rng)/rng)**2; }
  return Math.sqrt(s / TABLE.length);
}
async function bestBC(table, lo, hi) { // coarse->fine scan
  let best = lo, bestE = Infinity;
  for (let step of [0.2, 0.02]) {
    for (let bc = lo; bc <= hi; bc += step) { const e = await rmsErr(bc, table);
      if (e < bestE) { bestE = e; best = bc; } }
    lo = best - step; hi = best + step;
  }
  return { bc: best, rms: bestE };
}
for (const [name, table, lo, hi] of [['G1', DragTables.G1, 3, 8], ['G7', DragTables.G7, 1.5, 5]]) {
  const { bc, rms } = await bestBC(table, lo, hi);
  console.log(`\n=== ${name}  best BC = ${bc.toFixed(3)}  (RMS range err ${(rms*100).toFixed(2)}%) ===`);
  console.log('  elev   table_rng  model_rng   d%    | table_tof model_tof | table_sv model_sv | table_aof model_aof');
  for (const [el, rng, sv, tof, aof] of TABLE) {
    const m = await fire(bc, table, el);
    const d = ((m.range-rng)/rng*100);
    console.log(`  ${el.toFixed(1).padStart(4)}  ${String(rng).padStart(7)}m  ${m.range.toFixed(0).padStart(7)}m ${d>=0?'+':''}${d.toFixed(1)}%  | ${tof?String(tof).padStart(5):'  -- '}s  ${m.tof.toFixed(1).padStart(5)}s | ${sv?String(sv).padStart(4):' -- '}  ${m.sv.toFixed(0).padStart(4)} | ${aof?String(aof).padStart(4):' -- '}  ${m.aof.toFixed(1).padStart(4)}`);
  }
}
