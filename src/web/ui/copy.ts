import { SafeHtml, html } from '../html.js';

/**
 * A Copy button, wired by KIT_SCRIPT. `target: 'near'` copies the textarea
 * in the button's [data-copy-box] (found by position: for member data, so
 * no id is involved); a literal id string copies that textarea. With
 * `thenSubmit` the button is its form's submit button and the form is sent
 * only after the copy succeeded (without JavaScript it submits as usual).
 */
export function copyButton(options: {
  label: string;
  /** 'near', or the literal id of a textarea written in this codebase. */
  target: 'near' | { id: 'hof-post' | 'hof-post-mentions' };
  thenSubmit?: boolean;
}): SafeHtml {
  const id = options.target === 'near' ? '' : options.target.id;
  // One line each, so the button's text is exactly the label.
  // prettier-ignore
  return options.thenSubmit
    ? html`<button type="submit" data-copy="${id}" data-then-submit>${options.label}</button>`
    : html`<button type="button" data-copy="${id}">${options.label}</button>`;
}

/** A readonly message textarea and its Copy button, in one [data-copy-box]. */
export function copyBox(text: string, label: string): SafeHtml {
  return html`<div data-copy-box>
    ${copyText(text)}${copyButton({ label, target: 'near' })}
  </div>`;
}

/** The readonly textarea a copy box holds. RCDATA: escaped text only. */
export function copyText(text: string): SafeHtml {
  return html`<textarea class="copy" readonly rows="8">${text}</textarea>`;
}
