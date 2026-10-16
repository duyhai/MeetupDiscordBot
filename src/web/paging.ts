import { SafeHtml, html } from './html.js';

export const PAGE_SIZE = 50;
export const MAX_PAGE = 10_000;

/** `?page=` as 1..MAX_PAGE; anything but 1-5 plain digits is page 1. */
export function parsePage(value: unknown): number {
  if (typeof value !== 'string' || !/^[0-9]{1,5}$/.test(value)) {
    return 1;
  }
  const page = Number(value);
  return page < 1 ? 1 : Math.min(page, MAX_PAGE);
}

/** `path` is a constant from DASHBOARD_PATHS; params are already-validated values. */
export function pageNav(
  path: string,
  page: number,
  hasNext: boolean,
  params: Record<string, string | undefined> = {},
): SafeHtml {
  const href = (p: number) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') {
        query.set(k, v);
      }
    });
    query.set('page', String(p));
    return `${path}?${query.toString()}`;
  };
  return html`<nav class="pager">
    ${page > 1 ? html`<a href="${href(page - 1)}">Previous</a>` : ''}
    <span>Page ${page}</span>
    ${hasNext && page < MAX_PAGE ? html`<a href="${href(page + 1)}">Next</a>` : ''}
  </nav>`;
}
