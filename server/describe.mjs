// Optional backend for prompt iteration: renders the CEP zone as a map image
// and asks a Claude vision model to write the casual aside (the "tail") that
// follows the Nominatim place name. Mirrors the cron path in
// scripts/enrich-impact.mjs so prompt changes can be iterated locally.
//
// Run:  ANTHROPIC_API_KEY=sk-ant-... npm run proxy
// POST /api/describe with { center:{lat,lon}, ellipse:[[lat,lon],...], placeLabel? }.
// If placeLabel is omitted, Nominatim is queried. Returns
// { description: "${place}, ${tail}.", tail, placeLabel }.
//
// The cron path is what visitors see; this proxy is purely for iteration. Keep
// the SYSTEM prompt below in sync with scripts/enrich-impact.mjs by hand.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import StaticMaps from 'staticmaps';

import { buildLabel } from '../src/describe.js';

const PORT = process.env.DESCRIBE_PORT || 8787;
// Default Haiku, matching the cron. Flip to claude-sonnet-4-6 / claude-opus-4-7
// here when iterating on richer tails; the cron stays cheap.
const MODEL = process.env.DESCRIBE_MODEL || 'claude-haiku-4-5';
const NOMINATIM_UA = 'belfast-ballistics/1.0 (demo)';

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

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const cache = new Map(); // key: "lat,lon|placeLabel" -> { description, tail, placeLabel }

/** Render the CEP zone as a PNG: OSM basemap + red ellipse + red impact dot. */
async function renderCepMap(center, ellipse) {
  const map = new StaticMaps({
    width: 640,
    height: 540,
    padding: [80, 80],
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileRequestHeader: { 'User-Agent': NOMINATIM_UA }
  });
  // staticmaps coords are [lon, lat]
  map.addPolygon({
    coords: ellipse.map(([lat, lon]) => [lon, lat]),
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

async function fetchPlace(lat, lon) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}` +
    `&format=jsonv2&zoom=18&addressdetails=1`;
  const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return buildLabel(await res.json());
}

function buildUserText(placeLabel) {
  return `Place-name prefix: "${placeLabel}".\n\nWrite the fragment.`;
}

/** Ask the vision model for just the tail fragment. */
async function describeTail(pngBuffer, placeLabel) {
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
            source: { type: 'base64', media_type: 'image/png', data: pngBuffer.toString('base64') }
          },
          { type: 'text', text: buildUserText(placeLabel) }
        ]
      }
    ]
  });
  const block = resp.content.find((b) => b.type === 'text');
  return block?.text?.trim() ?? null;
}

/** Strip echoed prefix + stray punctuation so the concat comes out clean. */
function cleanTail(raw, placeLabel) {
  let t = raw.trim();
  const pfx = placeLabel.toLowerCase();
  if (t.toLowerCase().startsWith(pfx)) t = t.slice(pfx.length);
  t = t.replace(/^[\s,.;:!?\-–—]+/, '');
  t = t.replace(/[.\s]+$/, '');
  return t;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

export function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    if (req.method === 'GET' && req.url === '/api/health') {
      return sendJson(res, 200, { ok: true, model: MODEL, hasKey: Boolean(process.env.ANTHROPIC_API_KEY) });
    }
    if (req.method !== 'POST' || req.url !== '/api/describe') return sendJson(res, 404, { error: 'not found' });
    if (!process.env.ANTHROPIC_API_KEY) return sendJson(res, 503, { error: 'no ANTHROPIC_API_KEY configured' });

    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', async () => {
      try {
        const { center, ellipse, placeLabel: providedLabel } = JSON.parse(raw || '{}');
        if (!center || !Array.isArray(ellipse) || ellipse.length < 3) {
          return sendJson(res, 400, {
            error: 'expected { center:{lat,lon}, ellipse:[[lat,lon],...], placeLabel? }'
          });
        }

        let placeLabel = providedLabel;
        if (!placeLabel) {
          const place = await fetchPlace(center.lat, center.lon);
          placeLabel = place?.place;
          if (!placeLabel) {
            return sendJson(res, 422, {
              error: 'Nominatim returned no usable place — pass placeLabel explicitly'
            });
          }
        }

        const key = `${center.lat.toFixed(4)},${center.lon.toFixed(4)}|${placeLabel}`;
        if (cache.has(key)) return sendJson(res, 200, { ...cache.get(key), cached: true });

        const png = await renderCepMap(center, ellipse);
        const rawTail = await describeTail(png, placeLabel);
        const tail = rawTail ? cleanTail(rawTail, placeLabel) : null;
        const description = tail ? `${placeLabel}, ${tail}.` : null;
        const payload = { description, tail, placeLabel };
        if (description) {
          cache.set(key, payload);
          if (cache.size > 500) cache.delete(cache.keys().next().value);
        }
        sendJson(res, 200, payload);
      } catch (err) {
        console.error('describe failed:', err);
        sendJson(res, 502, { error: 'describe failed', detail: String(err?.message || err) });
      }
    });
  });

  server.listen(PORT, () => {
    console.log(
      `describe proxy on http://localhost:${PORT}  (model: ${MODEL}, key: ${
        process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING'
      })`
    );
  });
  return server;
}

// Start only when run directly — importing (for the render helpers) must not listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

export { renderCepMap, describeTail, cleanTail, fetchPlace };
