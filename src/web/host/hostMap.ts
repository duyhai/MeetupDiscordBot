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
import { gzipSync } from 'node:zlib';

import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import { EventPlaces } from '../../lib/leaderboard/places.js';
import {
  SafeHtml,
  SafeUrl,
  html,
  localUrl,
  memberText,
  staticRaw,
} from '../html.js';
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

/** Leaflet's version, pinned in package.json; it versions the asset URLs. */
export const LEAFLET_VERSION = '1.9.4';

/** What a map page loads besides its own inline script. */
export const MAP_ASSETS: { stylesheets: SafeUrl[]; scripts: SafeUrl[] } = {
  stylesheets: [
    localUrl(`${HOST_BASE}/assets/leaflet.css?v=${LEAFLET_VERSION}`),
  ],
  scripts: [localUrl(`${HOST_BASE}/assets/leaflet.js?v=${LEAFLET_VERSION}`)],
};

/**
 * A profile map draws only areas where that host has hosted at least this
 * many events, so no single area of one person's hosting (a home, say) is
 * drawn beside their name; the rest are counted in the text. The hall of
 * fame map draws every area. Hai may change it.
 */
export const PROFILE_MAP_MIN_EVENTS = 3;

/** How many cities the list names; the rest are summed. */
export const MAP_CITIES_SHOWN = 8;

/**
 * Serves Leaflet's two files, read and gzipped once from node_modules (the
 * app has no compression middleware: 147 KB of script becomes about 42 KB).
 * The URLs carry the version, so the files are cached for a year.
 */
export function registerMapAssets(router: express.Router): void {
  const require = createRequire(import.meta.url);
  const loaded = new Map<AssetName, Promise<{ raw: Buffer; gzip: Buffer }>>();
  const load = (name: AssetName) => {
    let file = loaded.get(name);
    if (file === undefined) {
      file = readFile(require.resolve(ASSETS[name].module)).then((raw) => ({
        raw,
        gzip: gzipSync(raw),
      }));
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
      const { raw, gzip } = await load(name);
      res
        .set('Cache-Control', 'private, max-age=31536000, immutable')
        .set('Vary', 'Accept-Encoding')
        .type(ASSETS[name].type);
      if (req.acceptsEncodings('gzip') === 'gzip') {
        res.set('Content-Encoding', 'gzip').send(gzip);
      } else {
        res.send(raw);
      }
    } catch (error: unknown) {
      logger.warn(
        `Map asset read failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      res.status(503).type('text/plain').send('Unavailable');
    }
  }) as RequestHandler);
}

function are(n: number): string {
  return n === 1 ? 'is' : 'are';
}

/**
 * The map and the text that says the same: cities with counts (the rest
 * under "Elsewhere or unknown area"), areas not drawn, events online or
 * without a venue, and events whose venue is not collected yet. Every event
 * is in exactly one of those lines. `subject` finishes "Where … hosted";
 * `minEventsPerCell` is the threshold the places were built with.
 */
export function hostMap(
  places: EventPlaces,
  subject: string,
  minEventsPerCell = 1,
): SafeHtml {
  const { cells, cities, unknownCity, inSmallCells, unplaced, pending } =
    places;
  const placed = cities.reduce((sum, c) => sum + c.events, 0) + unknownCity;
  if (placed === 0 && unplaced === 0 && pending > 0) {
    return html`<p class="muted">
      Venue data is still being collected; the map fills in with the next daily
      update from Meetup.
    </p>`;
  }
  // [lat, lon, events]: numbers only, read back with JSON.parse.
  const data = JSON.stringify(cells.map((c) => [c.lat, c.lon, c.events]));
  const shown = cities.slice(0, MAP_CITIES_SHOWN);
  const elsewhere =
    cities.slice(MAP_CITIES_SHOWN).reduce((sum, c) => sum + c.events, 0) +
    unknownCity;
  const items = shown.map(
    (c) => html`<li>${memberText(c.city)}: ${plural(c.events, 'event')}</li>`,
  );
  const map =
    cells.length === 0
      ? html`<p class="muted">No areas to draw on the map yet.</p>`
      : html`<div
            class="map"
            role="region"
            aria-label="Map of hosted areas. The list below gives the same events by city."
            data-map-cells="${data}"
            hidden
          ></div>
          <figcaption class="muted">
            ${
              `Where ${subject} hosted: each square is an area (about 1 km across when zoomed in), ` +
              'darker where more events were held. Exact venues are never stored.'
            }
          </figcaption>`;
  return html`<figure class="host-map">
    ${map}
    ${
      placed > 0
        ? html`<ul class="map-cities">
            ${items}
            ${elsewhere > 0 ? html`<li>Elsewhere or unknown area: ${plural(elsewhere, 'event')}</li>` : ''}
          </ul>`
        : ''
    }
    ${
      inSmallCells > 0
        ? html`<p class="muted">
            ${
              `${plural(inSmallCells, 'event')} in other areas ` +
              `(fewer than ${minEventsPerCell} events each) ${are(inSmallCells)} counted above but not drawn.`
            }
          </p>`
        : ''
    }
    ${
      unplaced > 0
        ? html`<p class="muted">
            ${`${plural(unplaced, 'event')} online or without a venue ${are(unplaced)} not on the map.`}
          </p>`
        : ''
    }
    ${
      pending > 0
        ? html`<p class="muted">
            ${`Venue data for ${plural(pending, 'event')} is still being collected.`}
          </p>`
        : ''
    }
  </figure>`;
}

/**
 * Draws each [data-map-cells] container with Leaflet: OSM tiles (with
 * their attribution and a Referer, per OSM's tile policy), and the cells as
 * squares, never pins: the stored ~1 km cells from zoom 11, merged into
 * ~5 km squares from zoom 9 and ~10 km below that, so an area stays visible
 * when zoomed out. Darker with more events. Zoom stops at 13 so a square
 * never reads as a building. Does nothing if Leaflet did not load.
 */
export const MAP_SCRIPT = staticRaw`(function(){if(!window.L){return;}var accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#b4532a';Array.prototype.slice.call(document.querySelectorAll('[data-map-cells]')).forEach(function(el){var cells;try{cells=JSON.parse(el.getAttribute('data-map-cells')||'[]');}catch(e){return;}if(!cells.length){return;}el.hidden=false;var map=L.map(el,{scrollWheelZoom:false,maxZoom:13,minZoom:3});map.attributionControl.setPrefix(false);L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:13,referrerPolicy:'origin',attribution:'\\u00a9 \\u003ca href="https://www.openstreetmap.org/copyright"\\u003eOpenStreetMap\\u003c/a\\u003e contributors'}).addTo(map);var layer=L.layerGroup().addTo(map);function draw(){layer.clearLayers();var z=map.getZoom();var g=z>=11?0.01:(z>=9?0.05:0.1);var size=z>=11?'about 1 km':(z>=9?'about 5 km':'about 10 km');var squares={};cells.forEach(function(c){var i=Math.round(c[0]/g),j=Math.round(c[1]/g),k=i+','+j;squares[k]=squares[k]||{i:i,j:j,n:0};squares[k].n+=c[2];});var list=Object.keys(squares).map(function(k){return squares[k];});var most=list.reduce(function(m,s){return Math.max(m,s.n);},1);list.forEach(function(s){var b=[[(s.i-0.5)*g,(s.j-0.5)*g],[(s.i+0.5)*g,(s.j+0.5)*g]];L.rectangle(b,{weight:1,color:accent,fillColor:accent,fillOpacity:0.2+0.5*Math.sqrt(s.n/most)}).bindTooltip(s.n+(s.n===1?' event':' events')+' in this area ('+size+' across)').addTo(layer);});}var all=[];cells.forEach(function(c){all.push([c[0]-0.005,c[1]-0.005],[c[0]+0.005,c[1]+0.005]);});map.fitBounds(all,{padding:[24,24],maxZoom:12});draw();map.on('zoomend',draw);});})();`;

/** What hostPage needs to draw a map: our Leaflet files, the tile CSP, the script. */
export const MAP_PAGE = {
  assets: MAP_ASSETS,
  mapTiles: true,
  script: MAP_SCRIPT,
};
