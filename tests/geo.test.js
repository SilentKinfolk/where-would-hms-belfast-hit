import { describe, it, expect } from 'vitest';
import {
  distanceMeters, bearingDeg, destinationPoint, compassName
} from '../src/geo.js';
import { BELFAST, TARGET } from '../src/data/belfast.js';

describe('geo', () => {
  it('distance Belfast -> target ~ 18.69 km', () => {
    const d = distanceMeters(BELFAST.position, TARGET.position);
    expect(d).toBeGreaterThan(18600);
    expect(d).toBeLessThan(18800);
  });

  it('distance from a point to itself is 0', () => {
    expect(distanceMeters(BELFAST.position, BELFAST.position)).toBeCloseTo(0, 6);
  });

  it('bearing Belfast -> target ~ 318 deg', () => {
    const b = bearingDeg(BELFAST.position, TARGET.position);
    expect(b).toBeGreaterThan(317);
    expect(b).toBeLessThan(319);
  });

  it('destinationPoint round-trips through distance and bearing', () => {
    const start = BELFAST.position;
    const dist = 10000; // 10 km
    const brng = 90;    // due east
    const end = destinationPoint(start, brng, dist);
    expect(distanceMeters(start, end)).toBeCloseTo(dist, -1); // within 0.5 m
    expect(bearingDeg(start, end)).toBeCloseTo(brng, 1);
  });

  it('compassName maps cardinal points', () => {
    expect(compassName(0)).toBe('N');
    expect(compassName(90)).toBe('E');
    expect(compassName(180)).toBe('S');
    expect(compassName(270)).toBe('W');
    expect(compassName(318)).toBe('NW');
  });
});
