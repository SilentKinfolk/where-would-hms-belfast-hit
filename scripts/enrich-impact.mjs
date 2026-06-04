// Adds the human-readable place name + AI vision one-liner to a ballistic
// result, so the cron-written JSON already carries them and the browser does
// no per-visit API calls. Also re-renders the social-share OG image.
//
// Mutates `result` in place:
//   result.place        — Nominatim label object (same shape as src/describe.js)
//   result.description  — one-line string: `${place.place}, ${tail}.`
//                         The Nominatim name grounds the proper noun; Claude
//                         only writes the casual locator aside, which is
//                         concatenated here. Locality is dropped.
//
// When `prevLatest` is supplied AND the new impact dot is within REUSE_DRIFT_M
// of the prior dot AND Nominatim returned the same `place.place`, the prior
// description is reused verbatim — no Claude call. Saves a render on ticks where
// the dot barely moved.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import StaticMaps from 'staticmaps';

import { destinationPoint, distanceMeters } from '../src/geo.js';
import { buildLabel } from '../src/describe.js';
import { fetchRetry } from '../src/fetch-retry.js';

const NOMINATIM_UA =
  'belfast-ballistics/1.0 (https://github.com/SilentKinfolk/where-would-hms-belfast-hit)';

const MODEL = process.env.DESCRIBE_MODEL || 'claude-sonnet-4-6';

// How far the impact dot may drift from the previous tick before its one-liner
// goes stale and a fresh Claude image-read earns its keep. Deliberately a fixed
// distance, NOT tied to cepM: the CEP measures fall-of-shot spread, but the line
// describes the feature *under the dot*, and that changes once the dot moves off
// it — however wide or narrow the dispersion happens to be. ~60 m is about
// golf-hole / building / junction scale.
const REUSE_DRIFT_M = 60;

// Tail-only prompt. The proper noun is pinned by Nominatim and concatenated as
// a prefix here; the model's only job is the casual locator aside.
const SYSTEM = `You complete a one-liner about where a naval shell would land, for a tongue-in-cheek website.

You are given a fixed place-name prefix (from OpenStreetMap), AND a map image with a red dot marking the most likely impact, sat inside a red ellipse showing the spread.

The final published line will read: "{prefix}, {your fragment}."

Your job is to write JUST the fragment.

Rules:
- Output a fragment of 3 to 8 words. No leading or trailing punctuation. Do NOT repeat the prefix.
- Start with a comma-natural opener like "somewhere", "just past", "near", "round about", "give or take", "over by", "back of".
- Ground the fragment in something visible on the map near the red dot: a hole number, a side road, a pond, a wood, a junction, a building, an aisle, a roundabout. Never invent a feature that is not shown.
- If little is labelled near the dot, stay vague (e.g. "give or take a fairway", "round the back somewhere", "near the trees").
- Casual spoken register. No commentary about consequences, traffic, or what happens next. Never a set-up and punchline joke.
- Commas only inside the fragment. No dashes of any kind. No emoji, no quote marks.

Output only the fragment. No preamble, no explanation.

Examples of just the fragment (do not reuse):
give or take an aisle
somewhere near the ponds
just past the petrol station
round about the 13th
back of the bandstand`;

function ellipseRing(center, ellipse, steps = 40) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const along = destinationPoint(
      center,
      ellipse.orientationDeg,
      ellipse.semiMajorM * Math.cos(t)
    );
    const p = destinationPoint(
      along,
      (ellipse.orientationDeg + 90) % 360,
      ellipse.semiMinorM * Math.sin(t)
    );
    ring.push([p.lat, p.lon]);
  }
  return ring;
}

async function renderCepMap(center, ring) {
  const map = new StaticMaps({
    width: 640,
    height: 540,
    padding: [80, 80],
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileRequestHeader: { 'User-Agent': NOMINATIM_UA }
  });
  map.addPolygon({
    coords: ring.map(([lat, lon]) => [lon, lat]),
    color: '#cc0000ff',
    width: 3,
    fill: '#cc000018'
  });
  map.addCircle({
    coord: [center.lon, center.lat],
    radius: 22,
    color: '#cc0000ff',
    fill: '#cc0000ff',
    width: 2
  });
  await map.render();
  return map.image.buffer('image/png');
}

function buildUserText(placeLabel) {
  return `Place-name prefix: "${placeLabel}".\n\nWrite the fragment.`;
}

async function describeTail(client, pngBuffer, placeLabel) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 60,
    thinking: { type: 'disabled' },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: pngBuffer.toString('base64')
            }
          },
          { type: 'text', text: buildUserText(placeLabel) }
        ]
      }
    ]
  });
  const block = resp.content.find((b) => b.type === 'text');
  return block?.text?.trim() ?? null;
}

async function fetchPlace(lat, lon) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}` +
    `&format=jsonv2&zoom=18&addressdetails=1`;
  const res = await fetchRetry(url, { headers: { 'User-Agent': NOMINATIM_UA } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return buildLabel(await res.json());
}

// Reuse the prior tick's description verbatim when the impact dot has barely
// moved AND the Nominatim place hasn't flipped. Both conditions matter: a drift
// across a road boundary changes the proper noun even if the map looks almost
// identical, and the cached prefix would then be wrong. The move is measured
// centre-dot to centre-dot — this tick's impact against last tick's.
function canReuseDescription(result, prev) {
  if (!prev?.description || !prev?.place || !result.place) return false;
  if (result.place.place !== prev.place.place) return false;
  const d = distanceMeters(
    { lat: result.impact.lat, lon: result.impact.lon },
    { lat: prev.impact.lat, lon: prev.impact.lon }
  );
  return d <= REUSE_DRIFT_M;
}

// Defensive: if the model echoed the prefix or added punctuation, strip it so
// the concatenation comes out clean.
function cleanTail(raw, placeLabel) {
  let t = raw.trim();
  const pfx = placeLabel.toLowerCase();
  if (t.toLowerCase().startsWith(pfx)) t = t.slice(pfx.length);
  t = t.replace(/^[\s,.;:!?\-–—]+/, '');
  t = t.replace(/[.\s]+$/, '');
  return t;
}

const OG_PATH = fileURLToPath(new URL('../public/og.png', import.meta.url));

/**
 * Render the social-share OG image: a 1200×630 map zoomed in to the CEP zone
 * with just the ellipse + impact marker. Greyscaled after render to match the
 * site's B&W aesthetic. The OSM basemap stays the tile source because no free
 * keyless B&W provider exists; sharp does the desaturation in one pass.
 */
async function renderOgImage(result) {
  const map = new StaticMaps({
    width: 1200,
    height: 630,
    // Force a tight zoom on the impact zone rather than letting staticmaps
    // auto-fit. At zoom 16 the OSM tiles show ~1.2 km of map across the 1200 px
    // canvas — plenty of road/feature context around a ~300 m ellipse without
    // losing the impact in pixel scale.
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileRequestHeader: { 'User-Agent': NOMINATIM_UA }
  });

  // 50% dispersion ellipse — black stroke + faint fill, matching the in-page map.
  if (result.ellipse) {
    const ring = ellipseRing(result.impact, result.ellipse, 60);
    map.addPolygon({
      coords: ring.map(([lat, lon]) => [lon, lat]),
      color: '#111111ff',
      width: 2,
      fill: '#11111118'
    });
  }

  // Impact marker — a solid black circle, easy to read after greyscale.
  map.addCircle({
    coord: [result.impact.lon, result.impact.lat],
    radius: 14,
    color: '#111111ff',
    fill: '#111111ff',
    width: 2
  });

  // Centre + fixed zoom keep the framing predictable regardless of ellipse size.
  await map.render([result.impact.lon, result.impact.lat], 16);
  const colourPng = await map.image.buffer('image/png');
  const greyPng = await sharp(colourPng).grayscale().png().toBuffer();
  await mkdir(fileURLToPath(new URL('../public/', import.meta.url)), { recursive: true });
  await writeFile(OG_PATH, greyPng);
  return OG_PATH;
}

export async function enrichImpact(result, prevLatest = null) {
  // Always refresh the place name. Free, surfaces edge moves even on ticks
  // where the description gets reused.
  try {
    const place = await fetchPlace(result.impact.lat, result.impact.lon);
    if (place) {
      result.place = place;
      console.log(`Place: ${place.place}${place.locality ? ` (${place.locality})` : ''}`);
    } else {
      console.log('Place: Nominatim returned no usable label.');
    }
  } catch (err) {
    console.warn('Place lookup failed:', err.message);
  }

  if (canReuseDescription(result, prevLatest)) {
    result.description = prevLatest.description;
    const d = Math.round(
      distanceMeters(
        { lat: result.impact.lat, lon: result.impact.lon },
        { lat: prevLatest.impact.lat, lon: prevLatest.impact.lon }
      )
    );
    console.log(
      `Reusing previous description (dot moved ${d} m, within ${REUSE_DRIFT_M} m): "${result.description}"`
    );
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set — skipping AI description.');
    return;
  }
  if (!result.place) {
    console.log('No Nominatim place — skipping AI description.');
    return;
  }
  if (!result.ellipse) {
    console.log('No ellipse on result — skipping AI description.');
    return;
  }

  try {
    const client = new Anthropic();
    const center = { lat: result.impact.lat, lon: result.impact.lon };
    const ring = ellipseRing(center, result.ellipse);
    const png = await renderCepMap(center, ring);
    const placeLabel = result.place.place;
    const rawTail = await describeTail(client, png, placeLabel);
    if (rawTail) {
      const tail = cleanTail(rawTail, placeLabel);
      if (tail) {
        result.description = `${placeLabel}, ${tail}.`;
        console.log(`Description (${MODEL}): ${result.description}`);
      } else {
        console.warn(`Claude tail cleaned to empty (raw: "${rawTail}") — skipping.`);
      }
    } else {
      console.warn('Claude returned no text block.');
    }
  } catch (err) {
    console.warn('AI description failed:', err.message);
  }
}

export async function renderOgImageForResult(result) {
  try {
    const path = await renderOgImage(result);
    console.log(`OG image: wrote ${path}`);
    return path;
  } catch (err) {
    console.warn('OG image render failed:', err.message);
    return null;
  }
}
