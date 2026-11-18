/**
 * The host maps: where hosted events happened, as ~1 km grid cells (the
 * snapshot never stores an exact venue). Leaflet 1.9.4 is served from our
 * own origin under the page nonce; tiles come from OpenStreetMap, the one
 * addition to a map page's CSP (hostPageKit mapContentSecurityPolicy).
 *
 * Without JavaScript (or for a screen reader) the city list below the map
 * says the same: the map container stays hidden until the script draws it.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import { EventPlaces } from '../../lib/leaderboard/places.js';
import { SafeHtml, SafeUrl, html, localUrl, staticRaw } from '../html.js';
import { plural } from './leaderboardKit.js';
import { HOST_BASE } from './hostSession.js';

const logger = new Logger({ name: 'hostDashboard' });

const ASSETS = {
  'leaflet.js': {
    module: 'leaflet/dist/leaflet.js',
    type: 'text/javascript; charset=utf-8',
  },
  'leaflet.css': {
    module: 'leaflet/dist/leaflet.css',
    type: 'text/css; charset=utf-8',
  },
} as const;

type AssetName = keyof typeof ASSETS;

/** What a map page loads besides its own inline script. */
export const MAP_ASSETS: { stylesheets: SafeUrl[]; scripts: SafeUrl[] } = {
  stylesheets: [localUrl(`${HOST_BASE}/assets/leaflet.css`)],
  scripts: [localUrl(`${HOST_BASE}/assets/leaflet.js`)],
};

/** How many cities the list names; the rest are summed. */
export const MAP_CITIES_SHOWN = 8;

/** Serves Leaflet's two files, read once from node_modules. */
export function registerMapAssets(router: express.Router): void {
  const require = createRequire(import.meta.url);
  const loaded = new Map<AssetName, Promise<Buffer>>();
  const load = (name: AssetName) => {
    let file = loaded.get(name);
    if (file === undefined) {
      file = readFile(require.resolve(ASSETS[name].module));
      loaded.set(name, file);
      file.catch(() => loaded.delete(name));
    }
    return file;
  };
  router.get('/assets/:name', (async (req, res) => {
    const { name } = req.params;
    if (name !== 'leaflet.js' && name !== 'leaflet.css') {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    try {
      const body = await load(name);
      res
        .set('Cache-Control', 'private, max-age=86400')
        .type(ASSETS[name].type)
        .send(body);
    } catch (error: unknown) {
      logger.warn(
        `Map asset read failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      res.status(503).type('text/plain').send('Unavailable');
    }
  }) as RequestHandler);
}

/**
 * The map and its city list. `subject` finishes "Where … hosted", e.g.
 * "the group has" or "they have". Nothing at all when no event has a place.
 */
export function hostMap(places: EventPlaces, subject: string): SafeHtml {
  const { cells, cities, unplaced } = places;
  if (cells.length === 0) {
    return html`<p class="muted">
      No hosted events with a venue on the map yet.
    </p>`;
  }
  // [lat, lon, events]: numbers only, read back with JSON.parse.
  const data = JSON.stringify(cells.map((c) => [c.lat, c.lon, c.events]));
  const shown = cities.slice(0, MAP_CITIES_SHOWN);
  const rest = cities
    .slice(MAP_CITIES_SHOWN)
    .reduce((sum, c) => sum + c.events, 0);
  const items = shown.map(
    (c) => html`<li>${`${c.city}: ${plural(c.events, 'event')}`}</li>`,
  );
  return html`<figure class="host-map">
    <div class="map" data-map-cells="${data}" hidden></div>
    <figcaption class="muted">
      ${`Where ${subject} hosted: each circle is an area about 1 km across, sized by events held there. Exact venues are never stored.`}
    </figcaption>
    <ul class="map-cities">
      ${items}
      ${rest > 0 ? html`<li>${`Elsewhere: ${plural(rest, 'event')}`}</li>` : ''}
    </ul>
    ${
      unplaced > 0
        ? html`<p class="muted">
            ${`${plural(unplaced, 'event')} online or without a venue ${unplaced === 1 ? 'is' : 'are'} not on the map.`}
          </p>`
        : ''
    }
  </figure>`;
}

/**
 * Draws each [data-map-cells] container with Leaflet: OSM tiles (with
 * their attribution and a Referer, per OSM's tile policy), one circle per
 * cell sized by events, zoom capped so a cell never reads as a street
 * address. Does nothing if Leaflet did not load.
 */
export const MAP_SCRIPT = staticRaw`(function(){if(!window.L){return;}var accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#b4532a';Array.prototype.slice.call(document.querySelectorAll('[data-map-cells]')).forEach(function(el){var cells;try{cells=JSON.parse(el.getAttribute('data-map-cells')||'[]');}catch(e){return;}if(!cells.length){return;}el.hidden=false;var map=L.map(el,{scrollWheelZoom:false,maxZoom:14,minZoom:3});map.attributionControl.setPrefix(false);L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:14,referrerPolicy:'origin',attribution:'\\u00a9 \\u003ca href="https://www.openstreetmap.org/copyright"\\u003eOpenStreetMap\\u003c/a\\u003e contributors'}).addTo(map);var most=cells.reduce(function(m,c){return Math.max(m,c[2]);},1);var points=[];cells.forEach(function(c){var r=5+13*Math.sqrt(c[2]/most);L.circleMarker([c[0],c[1]],{radius:r,weight:1,color:accent,fillColor:accent,fillOpacity:0.45}).bindTooltip(c[2]+(c[2]===1?' event':' events')).addTo(map);points.push([c[0],c[1]]);});map.fitBounds(points,{padding:[24,24],maxZoom:12});});})();`;

/** What hostPage needs to draw a map: our Leaflet files, the tile CSP, the script. */
export const MAP_PAGE = {
  assets: MAP_ASSETS,
  mapTiles: true,
  script: MAP_SCRIPT,
};
