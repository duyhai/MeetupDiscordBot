/**
 * The UI kit's icons (first drawn for the host tables), inline SVG (no
 * external asset, nothing the CSP has to admit). Decorative: each sits in a
 * control that carries its own accessible name, so they are aria-hidden and
 * never focusable.
 */
import { html } from '../html.js';

/** A red "m" tile, after Meetup's mark: the link it is in names Meetup. */
export const MEETUP_MARK = html`<svg
  class="icon meetup-mark"
  viewBox="0 0 24 24"
  width="20"
  height="20"
  aria-hidden="true"
  focusable="false"
>
  <rect x="1" y="1" width="22" height="22" rx="6" fill="#ed1c40" />
  <path
    d="M7.5 16.5v-5a2.25 2.25 0 0 1 4.5 0v5m0-5a2.25 2.25 0 0 1 4.5 0v5"
    fill="none"
    stroke="#fff"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>`;

/** Two sheets of paper, the usual "copy". Drawn in the text colour. */
export const COPY_ICON = html`<svg
  class="icon"
  viewBox="0 0 24 24"
  width="20"
  height="20"
  aria-hidden="true"
  focusable="false"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <rect x="9" y="9" width="11" height="11" rx="2" />
  <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
</svg>`;
