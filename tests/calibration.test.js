import { describe, it, expect } from 'vitest';
import { fireAtElevation } from '../src/ballistics/engine.js';

// All six rows from the NavWeaps range table for the 6"/50 Mk XXIII
// (MV 823 m/s, standard atmosphere). The fitted BC in belfast.js targets
// ~1.3 % RMS range error across these rows; this guards against regression.
const TABLE = [
  [2.3,  4570],
  [6.2,  9140],
  [13.1, 13720],
  [24.1, 18290],
  [41.1, 22400],
  [45.0, 23300]
];

describe('ballistics calibration', () => {
  it('matches the NavWeaps range table to within 1.5 % RMS', async () => {
    let sq = 0;
    for (const [el, expected] of TABLE) {
      const { rangeM } = await fireAtElevation(el);
      sq += ((rangeM - expected) / expected) ** 2;
    }
    const rms = Math.sqrt(sq / TABLE.length);
    expect(rms).toBeLessThan(0.015);
  }, 30000);
});
