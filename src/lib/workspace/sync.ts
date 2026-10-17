import { MEMBER_NAME_MAX, SyncCase } from './types.js';

const MEMBER_ID = /^[0-9]{1,20}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/**
 * The cases a no-show payload asks the workspace to hold, or undefined when
 * the payload is not one this code wrote: a sync is all or nothing, so one
 * malformed case never leaves a half-synced month. Ids must be digit
 * strings (cases[].member.id), never numbers.
 */
export function casesFromPayload(payload: unknown): SyncCase[] | undefined {
  if (
    !isObject(payload) ||
    payload.reportType !== 'no_show' ||
    !Array.isArray(payload.cases)
  ) {
    return undefined;
  }
  const seen = new Set<string>();
  const out: SyncCase[] = [];
  for (const c of payload.cases) {
    if (!isObject(c) || !isObject(c.member)) {
      return undefined;
    }
    const { id, name } = c.member;
    if (typeof id !== 'string' || !MEMBER_ID.test(id)) {
      return undefined;
    }
    if (c.classification !== 'warning' && c.classification !== 'suspension') {
      return undefined;
    }
    if (seen.has(id)) {
      // The build never repeats a member; keep the first.
      continue;
    }
    seen.add(id);
    const memberName = Array.from(typeof name === 'string' ? name : '')
      .slice(0, MEMBER_NAME_MAX)
      .join('');
    out.push({ memberId: id, memberName, classification: c.classification });
  }
  return out;
}
