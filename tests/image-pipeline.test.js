// Guards the OG-image path, which is the one production code path CI would
// otherwise never exercise: sharp runs only inside renderOgImage() in the
// hourly cron, so a bad sharp resolution used to surface as a silent cron
// failure hours later rather than as a red build.
//
// That matters because sharp reaches us transitively through staticmaps, which
// hard-pins "sharp": "0.33.2"; package.json defeats the pin with a direct
// dependency plus an { "sharp": "$sharp" } override. An override is exactly the
// kind of resolution that can go wrong quietly — the wrong version hoisted, or
// a platform binary that fails to load — so it needs a test that loads the real
// library and pushes bytes through it.
//
// Everything here is offline and deterministic. Rendering a real map would mean
// hammering OSM's tile servers on every CI run.

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

import { createRequire } from 'node:module';

const swatch = (r, g, b) =>
  sharp({ create: { width: 64, height: 32, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();

describe('image pipeline', () => {
  it('resolves a sharp free of the libvips advisory staticmaps pins us to', () => {
    // GHSA-f88m-g3jw-g9cj: the libvips CVEs are fixed from sharp 0.35.0.
    // staticmaps 1.13.1 pins 0.33.2, so this asserts the override still bites.
    const [major, minor] = sharp.versions.sharp.split('.').map(Number);
    expect(major > 0 || minor >= 35).toBe(true);
  });

  it('loads its native libvips binding', () => {
    expect(sharp.versions.vips).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('hoists one sharp for staticmaps and us to share', () => {
    // A nested copy would mean the override stopped applying and staticmaps
    // quietly went back to its pinned 0.33.2.
    const require = createRequire(import.meta.url);
    const fromHere = require.resolve('sharp');
    const fromStaticmaps = require.resolve('sharp', {
      paths: [require.resolve('staticmaps')]
    });
    expect(fromStaticmaps).toBe(fromHere);
  });

  it('renders, composites and resizes — the calls staticmaps makes', async () => {
    const base = await swatch(200, 30, 60);
    const mark = await swatch(10, 10, 10);

    const composed = await sharp(base)
      .composite([{ input: mark, top: 0, left: 0 }])
      .toBuffer();
    const resized = await sharp(composed).resize({ width: 16, fit: 'contain' }).toBuffer();

    expect((await sharp(resized).metadata()).width).toBe(16);
  });

  it('greyscales to a 1200x630 PNG, as renderOgImage() writes it', async () => {
    // Mirrors the final pass in scripts/enrich-impact.mjs: whatever staticmaps
    // hands back gets desaturated and written out at OG card dimensions.
    const colour = await sharp({
      create: { width: 1200, height: 630, channels: 4, background: { r: 180, g: 60, b: 20, alpha: 1 } }
    })
      .png()
      .toBuffer();

    const grey = await sharp(colour).grayscale().png().toBuffer();
    const meta = await sharp(grey).metadata();

    expect(meta.format).toBe('png');
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);

    // Greyscale means the three channels collapse to one value per pixel.
    const { data, info } = await sharp(grey).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBe(data[1]);
    expect(data[1]).toBe(data[2]);
    expect(info.width).toBe(1200);
  });
});
