// Probe trajectory sensitivities at the firing laying to set dispersion inputs.
import { Calculator, Shot, Weapon, Ammo, DragModel, DragTables, Atmo, UNew,
  Distance, TrajFlag, IntegrationMethod } from 'js-ballistics';
const TABLE = DragTables.G7, BC = 2.82;
const calc = new Calculator({ method: IntegrationMethod.RK4,
  config: { minimumVelocity: 0, minimumAltitude: -2000, maximumDrop: -500000 } });
async function range(mv, elevDeg) {
  const dm = new DragModel({ bc: BC, dragTable: TABLE, weight: UNew.Gram(50800), diameter: UNew.Inch(6.0) });
  const shot = new Shot({ weapon: new Weapon({ sightHeight: UNew.Meter(0), zeroElevation: UNew.Degree(elevDeg) }),
    ammo: new Ammo({ dm, mv: UNew.MPS(mv) }), atmo: Atmo.standard() });
  const hit = await calc.fire({ shot, trajectoryRange: UNew.Meter(30000), trajectoryStep: UNew.Meter(5000),
    filterFlags: TrajFlag.ALL, raiseRangeError: false });
  const imp = hit.flag(TrajFlag.ZERO_DOWN) ?? hit.trajectory[hit.trajectory.length-1];
  return imp.distance.In(Distance.Meter);
}
const MV = 823, EL = 25.1;
const dR_dv = (await range(MV+5, EL) - await range(MV-5, EL)) / 10;        // m per (m/s)
const dR_dQEdeg = (await range(MV, EL+0.5) - await range(MV, EL-0.5)) / 1;  // m per degree
console.log(`At laying ${EL}deg, MV ${MV}:`);
console.log(`  dRange/dMV   = ${dR_dv.toFixed(1)} m per m/s`);
console.log(`  dRange/dQE   = ${dR_dQEdeg.toFixed(0)} m per degree  (${(dR_dQEdeg/1000*0.9817).toFixed(1)} m per mil)`);
// Try candidate input PEs -> resulting range PE (PE = 0.6745*sigma; combine sigmas in quadrature)
const mil = 0.0009817; // rad
for (const [pe_mv, pe_qe_mil] of [[1.6,0.5],[2.5,1.0],[2.5,1.5],[4.0,1.0]]) {
  const sig_v = pe_mv/0.6745, sig_qe_deg = (pe_qe_mil*mil*180/Math.PI)/0.6745;
  const sig_range = Math.hypot(dR_dv*sig_v, dR_dQEdeg*sig_qe_deg);
  console.log(`  PE_MV=${pe_mv}m/s PE_QE=${pe_qe_mil}mil -> sigma_range=${sig_range.toFixed(0)}m, range PE=${(0.6745*sig_range).toFixed(0)}m`);
}
// deflection from lateral laying PE
for (const pe_def_mil of [0.5,1.0,1.5]) {
  const sig_def = 18800*(pe_def_mil*mil)/0.6745;
  console.log(`  lateral PE=${pe_def_mil}mil -> sigma_def=${sig_def.toFixed(0)}m, defl PE=${(0.6745*sig_def).toFixed(0)}m`);
}
