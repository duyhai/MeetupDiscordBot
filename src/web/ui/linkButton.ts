import { SafeHtml, SafeUrl, html } from '../html.js';
import type { ButtonTone } from './modal.js';

const CLASS: Record<ButtonTone, string> = {
  primary: 'button',
  ghost: 'button ghost',
  danger: 'button danger',
};

/**
 * A link that looks like a button: an <a class="button …">, so it stays a
 * link (middle click, copy address, no form). `external` opens it in a new
 * tab with rel="noopener noreferrer", as every off-site link here does.
 */
export function linkButton(options: {
  href: SafeUrl;
  label: string;
  /** Defaults to ghost. */
  tone?: ButtonTone;
  external?: boolean;
}): SafeHtml {
  const cls = CLASS[options.tone ?? 'ghost'];
  // One line each, so the link's text is exactly the label.
  // prettier-ignore
  return options.external
    ? html`<a class="${cls}" href="${options.href}" rel="noopener noreferrer" target="_blank">${options.label}</a>`
    : html`<a class="${cls}" href="${options.href}">${options.label}</a>`;
}
