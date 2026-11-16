import { describe, expect, it } from 'vitest';

import { html, localUrl } from '../../../src/web/html.js';
import { confirmModal, modal } from '../../../src/web/ui/modal.js';

const HOSTILE = '<script>alert(1)</script>"\'&';
const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;';

/** Whitespace collapsed between tags, for structure checks. */
const collapse = (body: string) =>
  body.replace(/\s+/g, ' ').replace(/> /g, '>').replace(/ </g, '<');

describe('modal', () => {
  it('is a details[data-modal] holding a summary and a dialog', () => {
    const out = collapse(
      modal({
        trigger: { label: 'Open it' },
        title: 'A title',
        body: html`<p>Body</p>`,
      }).value,
    );
    expect(out).toBe(
      '<details class="ui-modal" data-modal>' +
        '<summary class="button ghost">Open it</summary>' +
        '<dialog class="ui-dialog"><div class="ui-dialog-box">' +
        '<h2 class="ui-dialog-title" data-modal-title>A title</h2>' +
        '<div class="ui-dialog-body"><p>Body</p></div>' +
        '<div class="ui-dialog-actions">' +
        '<button type="button" class="ghost" data-modal-close>Close</button>' +
        '</div></div></dialog></details>',
    );
  });

  it('never opens on its own: no open attribute, no id', () => {
    const out = modal({
      trigger: { label: 'x' },
      title: 't',
      body: html``,
    }).value;
    expect(out).not.toMatch(/\sopen[\s>=]/);
    expect(out).not.toMatch(/\sid=/);
  });

  it.each([
    ['primary', 'button'],
    ['ghost', 'button ghost'],
    ['danger', 'button danger'],
  ] as const)('a %s trigger is class "%s"', (tone, cls) => {
    const out = modal({
      trigger: { label: 'x', tone },
      title: 't',
      body: html``,
    }).value;
    expect(out).toContain(`<summary class="${cls}">x</summary>`);
  });

  it('escapes the trigger label, the title and the close label', () => {
    const out = modal({
      trigger: { label: HOSTILE },
      title: HOSTILE,
      body: html`${HOSTILE}`,
      closeLabel: HOSTILE,
    }).value;
    expect(out).not.toContain('<script>');
    expect(out.split(ESCAPED)).toHaveLength(5);
  });
});

describe('confirmModal', () => {
  const ACTION = localUrl('/dashboard/no-shows/2026-09/rows/2');

  it('holds one POST form: tip, fields, Cancel, then a danger confirm', () => {
    const out = collapse(
      confirmModal({
        trigger: { label: 'Void', tone: 'danger' },
        title: 'Void it?',
        tip: 'What voiding does.',
        action: ACTION,
        fields: html`<input type="hidden" name="action" value="void" />`,
        confirmLabel: 'Void',
      }).value,
    );
    expect(out).toContain('<summary class="button danger">Void</summary>');
    expect(out).toContain(
      '<form method="post" action="/dashboard/no-shows/2026-09/rows/2">' +
        '<div class="ui-dialog-body"><p class="ui-tip">What voiding does.</p>' +
        '<input type="hidden" name="action" value="void" /></div>' +
        '<div class="ui-dialog-actions">' +
        '<button type="button" class="ghost" data-modal-close>Cancel</button>' +
        '<button type="submit" class="danger strong">Void</button>' +
        '</div></form>',
    );
    // The form is inside the dialog, never beside it.
    expect(out.indexOf('<dialog')).toBeLessThan(out.indexOf('<form'));
    expect(out.indexOf('</form>')).toBeLessThan(out.indexOf('</dialog>'));
    expect(out.match(/<form/g)).toHaveLength(1);
    expect(out.match(/type="submit"/g)).toHaveLength(1);
  });

  it('a primary confirm has no class', () => {
    const out = confirmModal({
      trigger: { label: 'Save' },
      title: 'Notes',
      tip: 'Tip',
      action: ACTION,
      fields: html``,
      confirmLabel: 'Save notes',
      tone: 'primary',
    }).value;
    expect(out).toContain('<button type="submit">Save notes</button>');
    expect(out).not.toContain('danger');
  });

  it('escapes the tip, title and labels; takes SafeHtml tips as markup', () => {
    const out = confirmModal({
      trigger: { label: HOSTILE },
      title: HOSTILE,
      tip: HOSTILE,
      action: ACTION,
      fields: html``,
      confirmLabel: HOSTILE,
    }).value;
    expect(out).not.toContain('<script>');
    expect(out.split(ESCAPED)).toHaveLength(5);
    const markup = confirmModal({
      trigger: { label: 'x' },
      title: 't',
      tip: html`Voiding <strong>${HOSTILE}</strong>`,
      action: ACTION,
      fields: html``,
      confirmLabel: 'y',
    }).value;
    expect(markup).toContain(
      `<p class="ui-tip">Voiding <strong>${ESCAPED}</strong></p>`,
    );
  });

  it('takes only a SafeUrl action', () => {
    expect(() =>
      confirmModal({
        trigger: { label: 'x' },
        title: 't',
        tip: 'tip',
        // @ts-expect-error -- a plain string is not a SafeUrl
        action: 'javascript:alert(1)',
        fields: html``,
        confirmLabel: 'y',
      }),
    ).toThrow();
  });
});
