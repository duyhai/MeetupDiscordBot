/**
 * The reviewer checklist on each leadership queue card (leadership,
 * 2026-11-10): what a leader confirms by eye before approving. A memory
 * aid, not a gate: Approve works with any boxes ticked. The ticked set is
 * recorded with the decision (event_request_events detail) and shown on
 * the card afterwards. Nothing here checks the event itself.
 */
export const REVIEW_CHECKLIST = [
  { key: 'location', label: 'Exact location in the title' },
  { key: 'photo', label: 'Non-default photo' },
  { key: 'rsvps', label: 'RSVPs open' },
  { key: 'lead-time', label: 'Starts 7 or more days out' },
  { key: 'content', label: 'Title and description reasonable' },
] as const;

export type ChecklistKey = (typeof REVIEW_CHECKLIST)[number]['key'];

const KEYS: readonly string[] = REVIEW_CHECKLIST.map((item) => item.key);

export const isChecklistKey = (value: unknown): value is ChecklistKey =>
  typeof value === 'string' && KEYS.includes(value);

/**
 * The ticked boxes from a form body's `check` field (a string, or an array
 * when several were ticked), in the checklist's order, unknown values
 * dropped. Anything else (missing, malformed) is no boxes.
 */
export function parseChecklist(value: unknown): ChecklistKey[] {
  const values = Array.isArray(value) ? value : [value];
  const ticked = new Set(values.filter(isChecklistKey));
  return REVIEW_CHECKLIST.map((item) => item.key).filter((key) =>
    ticked.has(key),
  );
}

/** The history row's detail for a decision made with the checklist. */
export function checklistDetail(ticked: readonly ChecklistKey[]): string {
  return JSON.stringify({ checklist: ticked });
}

/**
 * The ticked boxes a history row recorded; undefined for a row without a
 * checklist (a Discord approval, a retry, a row from before the feature).
 */
export function parseChecklistDetail(
  detail: string | null | undefined,
): ChecklistKey[] | undefined {
  if (typeof detail !== 'string' || !detail.startsWith('{')) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return undefined;
  }
  const list = (parsed as { checklist?: unknown } | null)?.checklist;
  return Array.isArray(list) ? parseChecklist(list) : undefined;
}

export const checklistLabel = (key: ChecklistKey): string =>
  REVIEW_CHECKLIST.find((item) => item.key === key)?.label ?? key;
