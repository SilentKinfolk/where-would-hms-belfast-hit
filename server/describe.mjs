// Optional backend: renders the CEP zone as a map image and asks a Claude vision
// model to read it (OCR the labels) and return ONE casual line for the headline.
//
// Run:  ANTHROPIC_API_KEY=sk-ant-... npm run proxy
// The static frontend calls POST /api/describe; if this proxy is down or has no
// key, the app falls back to the reverse-geocoded line. Key stays server-side.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import StaticMaps from 'staticmaps';

const PORT = process.env.DESCRIBE_PORT || 8787;
// Skill default is Opus 4.8. For this tiny per-refresh OCR call, set
// DESCRIBE_MODEL=claude-haiku-4-5 to cut cost (it reads map labels fine).
const MODEL = process.env.DESCRIBE_MODEL || 'claude-opus-4-8';

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

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const cache = new Map(); // key: rounded "lat,lon" -> description

/** Render the CEP zone as a PNG buffer: OSM basemap + red ellipse + impact dot. */
async function renderCepMap(center, ellipse) {
  const map = new StaticMaps({
    width: 640,
    height: 540,
    padding: [80, 80],
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileRequestHeader: { 'User-Agent': 'belfast-ballistics/1.0 (demo)' }
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

/** Ask the vision model to read the map and return the one-line description. */
async function describeCep(pngBuffer) {
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
            source: { type: 'base64', media_type: 'image/png', data: pngBuffer.toString('base64') }
          },
          { type: 'text', text: 'Where does it land?' }
        ]
      }
    ]
  });
  const block = resp.content.find((b) => b.type === 'text');
  return block?.text?.trim() ?? null;
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
      const { center, ellipse } = JSON.parse(raw || '{}');
      if (!center || !Array.isArray(ellipse) || ellipse.length < 3) {
        return sendJson(res, 400, { error: 'expected { center:{lat,lon}, ellipse:[[lat,lon],...] }' });
      }
      const key = `${center.lat.toFixed(4)},${center.lon.toFixed(4)}`;
      if (cache.has(key)) return sendJson(res, 200, { description: cache.get(key), cached: true });

      const png = await renderCepMap(center, ellipse);
      const description = await describeCep(png);
      if (description) {
        cache.set(key, description);
        if (cache.size > 500) cache.delete(cache.keys().next().value);
      }
      sendJson(res, 200, { description });
    } catch (err) {
      console.error('describe failed:', err);
      sendJson(res, 502, { error: 'describe failed', detail: String(err?.message || err) });
    }
  });
});

  server.listen(PORT, () => {
    console.log(`describe proxy on http://localhost:${PORT}  (model: ${MODEL}, key: ${process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING'})`);
  });
  return server;
}

// Start only when run directly — importing (for the render helpers) must not listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

export { renderCepMap, describeCep };
