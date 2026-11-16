import { SafeHtml, SafeUrl, html } from '../html.js';

/** One page in the nav. `key` is what the caller marks as current. */
export interface NavLink<K extends string = string> {
  key: K;
  href: SafeUrl;
  label: string;
}

/** A named group of pages: one accordion section. */
export interface NavGroup<K extends string = string> {
  group: string;
  links: readonly NavLink<K>[];
}

export type NavEntry<K extends string = string> = NavLink<K> | NavGroup<K>;

const isGroup = <K extends string>(e: NavEntry<K>): e is NavGroup<K> =>
  'group' in e;

function link<K extends string>(l: NavLink<K>, current: K | undefined) {
  // aria-current is a literal, on the item the caller named.
  // prettier-ignore
  return l.key === current
    ? html`<a href="${l.href}" aria-current="page">${l.label}</a>`
    : html`<a href="${l.href}">${l.label}</a>`;
}

/**
 * The site nav as an accordion: top-level links and details[data-nav-group]
 * sections, each a summary (the group's name) and its links. The group
 * holding the current page renders open and its summary is marked (class
 * "here"); the page's link carries aria-current="page".
 *
 * Without JavaScript every group opens and closes on its own, in place.
 * KIT_SCRIPT adds: opening one group closes the others, and Esc inside an
 * open group closes it and puts focus on its summary. With scripting on, the
 * stylesheet shows the open group's links as a second row under the bar.
 */
export function accordionNav<K extends string>(options: {
  label: string;
  entries: readonly NavEntry<K>[];
  current: K | undefined;
}): SafeHtml {
  const { current } = options;
  const items = options.entries.map((e) => {
    if (!isGroup(e)) {
      return link(e, current);
    }
    const links = html`<div class="nav-sub">
      ${e.links.map((l) => link(l, current))}
    </div>`;
    // prettier-ignore
    return e.links.some((l) => l.key === current)
      ? html`<details class="nav-group" data-nav-group open><summary class="here">${e.group}</summary>${links}</details>`
      : html`<details class="nav-group" data-nav-group><summary>${e.group}</summary>${links}</details>`;
  });
  return html`<nav class="site" aria-label="${options.label}" data-accordion>
    <div class="tabs">${items}</div>
  </nav>`;
}
