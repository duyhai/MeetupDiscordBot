import { SafeHtml, SafeUrl, html } from '../html.js';

/** How a trigger or confirm button looks: the stylesheet's button classes. */
export type ButtonTone = 'primary' | 'ghost' | 'danger';

const TRIGGER_CLASS: Record<ButtonTone, string> = {
  primary: 'button',
  ghost: 'button ghost',
  danger: 'button danger',
};

export interface ModalTrigger {
  /** The button's text (escaped). */
  label: string;
  /** Defaults to ghost. */
  tone?: ButtonTone;
}

/**
 * The shell both modals share. Markup is a details[data-modal]: without
 * JavaScript (or without <dialog> support) the summary opens the panel in
 * place, so every form in it stays reachable. KIT_SCRIPT turns the summary
 * into a real button that opens the dialog with showModal; see script.ts.
 */
function shell(
  trigger: ModalTrigger,
  title: string,
  inner: SafeHtml,
): SafeHtml {
  const cls = TRIGGER_CLASS[trigger.tone ?? 'ghost'];
  return html`<details class="ui-modal" data-modal>
    <summary class="${cls}">${trigger.label}</summary>
    <dialog class="ui-dialog">
      <div class="ui-dialog-box">
        <h2 class="ui-dialog-title" data-modal-title>${title}</h2>
        ${inner}
      </div>
    </dialog>
  </details>`;
}

/**
 * A button that opens a dialog: a title, the body, and a Close button. Esc
 * and the backdrop close it too, and focus goes back to the button.
 */
export function modal(options: {
  trigger: ModalTrigger;
  title: string;
  body: SafeHtml;
  closeLabel?: string;
}): SafeHtml {
  return shell(
    options.trigger,
    options.title,
    html`<div class="ui-dialog-body">${options.body}</div>
      <div class="ui-dialog-actions">
        <button type="button" class="ghost" data-modal-close>
          ${options.closeLabel ?? 'Close'}
        </button>
      </div>`,
  );
}

/**
 * A modal holding one POST form whose submit is the confirming action: a
 * short tip, the form's own fields (hidden inputs included), then Cancel and
 * the confirm button (danger-styled unless tone says otherwise). Nothing is
 * sent until the confirm button is pressed.
 */
export function confirmModal(options: {
  trigger: ModalTrigger;
  title: string;
  /** What the action does, in a sentence or two. */
  tip: SafeHtml | string;
  action: SafeUrl;
  fields: SafeHtml;
  confirmLabel: string;
  /** Defaults to danger. */
  tone?: 'danger' | 'primary';
}): SafeHtml {
  // One line each, so the button's text is exactly the label.
  // prettier-ignore
  const confirm =
    (options.tone ?? 'danger') === 'danger'
      ? html`<button type="submit" class="danger strong">${options.confirmLabel}</button>`
      : html`<button type="submit">${options.confirmLabel}</button>`;
  return shell(
    options.trigger,
    options.title,
    html`<form method="post" action="${options.action}">
      <div class="ui-dialog-body">
        <p class="ui-tip">${options.tip}</p>
        ${options.fields}
      </div>
      <div class="ui-dialog-actions">
        <button type="button" class="ghost" data-modal-close>Cancel</button>
        ${confirm}
      </div>
    </form>`,
  );
}
