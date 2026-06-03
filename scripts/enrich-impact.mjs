// Adds the human-readable place name + AI vision one-liner to a ballistic
// result, so the cron-written JSON already carries them and the browser does
// no per-visit API calls.
//
// Mutates `result` in place:
//   result.place        — Nominatim label object (same shape as src/describe.js)
//   result.description  — one-line Claude vision string
//
// Both calls are best-effort. If either fails (no key, Nominatim down, model
// error, no ellipse to render) the field is just left unset; the cron still
// commits the engine result and main.js falls back to a client-side Nominatim
// lookup for `place`.

import Anthropic from '@anthropic-ai/sdk';
import StaticMaps from 'staticmaps';

import { destinationPoint } from '../src/geo.js';
import { buildLabel } from '../src/describe.js';

const NOMINATIM_UA =
  'belfast-ballistics/1.0 (https://github.com/SilentKinfolk/where-would-hms-belfast-hit)';

const MODEL = process.env.DESCRIBE_MODEL || 'claude-haiku-4-5';

// Same prompt the local proxy uses (server/describe.mjs). Kept in sync by
// re-pasting if it changes there — small enough not to be worth a third file.
const SYSTEM = `You describe where a naval shell would land, for a tongue-in-cheek website.

You are shown a map image with a red dot marking the most likely impact point, sat inside a red ellipse showing the spread (how far off it might be).

Read the place names and labels on the map and reply with ONE short, casual line saying where it comes down, the way someone glancing at the map would say it out loud.

Rules:
- Describe the spot under the red dot. You may use the ellipse for a light "give or take" aside.
- Always include a proper-noun place name (Mill Hill Golf Course, A1, Hampstead Heath, Sainsbury's, Tesco Extra, the Brent Reservoir). Generic descriptors like "the fairway", "the road", "a field", "the park" do NOT count on their own. Pair the proper noun with the most specific nearby feature you can see (a hole number, a side road, a named wood, a junction, a pond, an aisle, the bandstand). Both halves must be in the line. Never the feature alone without the named place.
- Use only names and labels actually visible on the map. Never invent a road, hole, or place that is not shown. If little is labelled, stay vaguer: name the neighbourhood or town from the map, plus whatever you can see.
- One line, 12 words max. Casual spoken register. A light throwaway aside about the place itself is welcome (e.g. "give or take an aisle"). No commentary about consequences, traffic, or what happens next. Never a set-up and punchline joke.
- Commas and full stops only. No dashes of any kind. No emoji, no quote marks.

Output only the single line. No preamble, no explanation.

Tone and shape to match (do not reuse these places):
Sainsbury's car park in Witney, give or take an aisle.
Middle of Hampstead Heath, somewhere near the ponds.
The A41 outside Berkhamsted, just past the petrol station.`;

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
  if (!placeLabel) return 'Where does it land?';
  return `Where does it land?\n\nOpenStreetMap labels the impact point as "${placeLabel}". Use this name (or a natural variant) as the proper-noun half of your line, unless the map clearly shows a more specific named place at the red dot.`;
}

async function describeCep(client, pngBuffer, placeLabel) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 120,
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
  const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return buildLabel(await res.json());
}

export async function enrichImpact(result) {
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

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set — skipping AI description.');
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
    const placeLabel = result.place
      ? [result.place.place, result.place.locality].filter(Boolean).join(', ')
      : null;
    const description = await describeCep(client, png, placeLabel);
    if (description) {
      result.description = description;
      console.log(`Description (${MODEL}): ${description}`);
    } else {
      console.warn('Claude returned no text block.');
    }
  } catch (err) {
    console.warn('AI description failed:', err.message);
  }
}
