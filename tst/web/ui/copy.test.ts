import { describe, expect, it } from 'vitest';

import { copyBox, copyButton, copyText } from '../../../src/web/ui/copy.js';

const HOSTILE = '</textarea><script>alert(1)</script>"&';

describe('copyButton', () => {
  it("'near' copies the box's textarea: an empty data-copy, no id", () => {
    expect(copyButton({ label: 'Copy message', target: 'near' }).value).toBe(
      '<button type="button" data-copy="">Copy message</button>',
    );
  });

  it('a literal id copies that textarea', () => {
    expect(
      copyButton({ label: 'Copy', target: { id: 'hof-post' } }).value,
    ).toBe('<button type="button" data-copy="hof-post">Copy</button>');
  });

  it('thenSubmit is the form submit button, marked data-then-submit', () => {
    expect(
      copyButton({ label: 'Copy warning', target: 'near', thenSubmit: true })
        .value,
    ).toBe(
      '<button type="submit" data-copy="" data-then-submit>Copy warning</button>',
    );
  });

  it('escapes the label', () => {
    const out = copyButton({ label: HOSTILE, target: 'near' }).value;
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;/textarea&gt;&lt;script&gt;');
  });
});

describe('copyBox / copyText', () => {
  it('keeps the message as escaped textarea text, never an attribute', () => {
    const out = copyBox(HOSTILE, 'Copy').value;
    const escaped =
      '&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;';
    expect(out.replace(/\s+/g, ' ')).toBe(
      '<div data-copy-box> ' +
        `<textarea class="copy" readonly rows="8">${escaped}</textarea>` +
        '<button type="button" data-copy="">Copy</button> </div>',
    );
    expect(out).not.toContain('<script>');
    expect(copyText('a').value).toBe(
      '<textarea class="copy" readonly rows="8">a</textarea>',
    );
  });
});
