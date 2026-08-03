import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BELFAST, TARGET } from './data/belfast.js';
import { destinationPoint } from './geo.js';

// Build a closed ring of lat/lng points for an ellipse centred at `center`,
// with `semiMajorM` along `orientationDeg` and `semiMinorM` perpendicular.
function ellipseRing(center, semiMajorM, semiMinorM, orientationDeg, steps = 72) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const along = destinationPoint(center, orientationDeg, semiMajorM * Math.cos(t));
    const p = destinationPoint(along, (orientationDeg + 90) % 360, semiMinorM * Math.sin(t));
    ring.push([p.lat, p.lon]);
  }
  return ring;
}

// Use divIcons (styled HTML) rather than Leaflet's default PNG markers, which
// avoids the well-known broken-image-path issue under bundlers like Vite.
function pin(symbol, modifier) {
  return L.divIcon({
    className: '',
    html: `<div class="map-pin map-pin--${modifier}">${symbol}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -16]
  });
}

const ICONS = {
  belfast: pin('■', 'belfast'), // the ship / firing origin
  target: pin('◎', 'target'), // where the guns are aimed
  impact: pin('✕', 'impact') // where the shell lands
};

/**
 * Initialise the Leaflet map with the static ship + target markers, and return
 * a small controller the rest of the app uses to render firing solutions.
 */
export function createMap(elementId) {
  const map = L.map(elementId, { zoomControl: true }).setView([51.57, -0.17], 11);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const belfastLatLng = [BELFAST.position.lat, BELFAST.position.lon];

  L.marker(belfastLatLng, { icon: ICONS.belfast })
    .addTo(map)
    .bindPopup(`<strong>${BELFAST.name}</strong><br>${BELFAST.description}`);

  L.marker([TARGET.position.lat, TARGET.position.lon], { icon: ICONS.target })
    .addTo(map)
    .bindPopup(`<strong>${TARGET.name}</strong><br>${TARGET.aka}<br><em>${TARGET.note}</em>`);

  // Layers that change when a new solution is computed.
  const historyLayer = L.layerGroup().addTo(map); // under everything else
  const dispersionLayer = L.layerGroup().addTo(map);
  let bearingLine = null;
  let impactMarker = null;

  /** Render an ImpactResult: bearing line, impact marker, 50% ellipse and CEP. */
  function showSolution(result) {
    const impactLatLng = [result.impact.lat, result.impact.lon];

    // The real simulated ground track (curved by wind/Coriolis/spin), not a
    // straight bearing line. Falls back to a straight line if no track given.
    if (bearingLine) bearingLine.remove();
    const trackPts = result.track && result.track.length > 1 ? result.track : [belfastLatLng, impactLatLng];
    bearingLine = L.polyline(trackPts, {
      color: '#111',
      weight: 2,
      opacity: 0.9
    }).addTo(map);

    dispersionLayer.clearLayers();

    // 50% zone: where the single shell most likely lands (long in range).
    if (result.ellipse) {
      L.polygon(
        ellipseRing(
          result.impact,
          result.ellipse.semiMajorM,
          result.ellipse.semiMinorM,
          result.ellipse.orientationDeg
        ),
        { color: '#111', weight: 1.2, fillColor: '#111', fillOpacity: 0.12 }
      )
        .bindPopup('<strong>50% zone</strong><br>the shell lands in here about half the time')
        .addTo(dispersionLayer);
    }

    // CEP — the equivalent 50% circle.
    if (result.cepM > 0) {
      L.circle(impactLatLng, {
        radius: result.cepM,
        color: '#111',
        weight: 1,
        dashArray: '3 5',
        fill: false
      })
        .bindPopup(`<strong>CEP</strong><br>${Math.round(result.cepM)} m`)
        .addTo(dispersionLayer);
    }

    if (impactMarker) impactMarker.remove();
    impactMarker = L.marker(impactLatLng, { icon: ICONS.impact })
      .addTo(map)
      .bindPopup('<strong>Most likely impact point</strong>');

    map.fitBounds(L.latLngBounds([belfastLatLng, impactLatLng]).pad(0.35));
  }

  /**
   * Render the "ghost" trail of past estimates: a faint time-ordered trail plus
   * faded dots (newer = brighter/larger). Pass show=false to hide.
   */
  function showHistory(entries, show) {
    historyLayer.clearLayers();
    if (!show || !entries || entries.length === 0) return;

    // The trail comes from the cron-written impacts.json — its latest entry is
    // up to an hour old and distinct from the browser's live point, so render
    // every entry as a ghost (no slicing).
    const ghosts = entries;

    const n = ghosts.length;
    ghosts.forEach((e, i) => {
      const recency = n > 1 ? i / (n - 1) : 1; // 0 (oldest) … 1 (newest ghost)
      const opacity = 0.35 + 0.45 * recency;
      const when = new Date(e.t).toLocaleString();
      const wind = e.wind ? `${e.wind.speedMs} m/s from ${e.wind.dirDeg}°` : '—';

      // Ghost bearing line: ship → this past impact (faint copy of the live
      // dashed line). The fan of these shows how the fall of shot has wandered.
      L.polyline([belfastLatLng, [e.lat, e.lon]], {
        color: '#888',
        weight: 1,
        opacity: opacity * 0.7,
        dashArray: '8 8'
      }).addTo(historyLayer);

      // Oblong 50% zone as a stroke-only outline (no fill — so coincident ghosts
      // can't stack into a blob or cover the live ellipse).
      if (e.ellipse) {
        L.polygon(
          ellipseRing(
            { lat: e.lat, lon: e.lon },
            e.ellipse.semiMajorM,
            e.ellipse.semiMinorM,
            e.ellipse.orientationDeg
          ),
          { color: '#888', weight: 1.2, opacity, fill: false }
        ).addTo(historyLayer);
      }
      L.circleMarker([e.lat, e.lon], {
        radius: 2.5 + 2 * recency,
        color: '#888',
        weight: 1,
        opacity,
        fillColor: '#888',
        fillOpacity: opacity * 0.5
      })
        .bindPopup(
          `<strong>${when}</strong><br>miss ${e.missM} m · CEP ${e.cepM} m<br>wind aloft ${wind}`
        )
        .addTo(historyLayer);
    });
  }

  return { map, showSolution, showHistory };
}
