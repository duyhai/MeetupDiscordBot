import { SafeHtml, html } from '../html.js';

/**
 * A section that folds: a details.ui-collapsible whose summary is the
 * heading line and whose body sits under it. Works the same with or without
 * JavaScript (the browser opens and closes it). `open` starts it open.
 * `meta` is a short muted note on the summary line (counts, a date).
 */
export function collapsible(options: {
  summary: SafeHtml | string;
  meta?: SafeHtml | string;
  body: SafeHtml;
  open?: boolean;
}): SafeHtml {
  const meta =
    options.meta === undefined || options.meta === ''
      ? ''
      : html`<span class="ui-collapsible-meta">${options.meta}</span>`;
  const summary = html`<summary>
    <span class="ui-collapsible-title">${options.summary}</span>${meta}
  </summary>`;
  const body = html`<div class="ui-collapsible-body">${options.body}</div>`;
  // The open attribute is a literal: two templates, never an interpolation.
  return options.open
    ? html`<details class="ui-collapsible" open>${summary}${body}</details>`
    : html`<details class="ui-collapsible">${summary}${body}</details>`;
}
