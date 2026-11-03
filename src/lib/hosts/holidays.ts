/**
 * Dates shown on the host calendar. US holidays are computed by rule, so the
 * list never runs out; cultural dates whose day moves each year (lunar
 * calendar) are a static list that leadership extends.
 */
export interface CalendarDate {
  day: string; // YYYY-MM-DD
  name: string;
  kind: 'holiday' | 'cultural';
}

/** Leadership adds dates here (Hai's open item: "Holiday/cultural date list"). */
export const CULTURAL_DATES: readonly CalendarDate[] = [
  { day: '2026-02-17', name: 'Lunar New Year', kind: 'cultural' },
  { day: '2027-02-06', name: 'Lunar New Year', kind: 'cultural' },
  { day: '2028-01-26', name: 'Lunar New Year', kind: 'cultural' },
  { day: '2026-09-25', name: 'Mid-Autumn Festival', kind: 'cultural' },
  { day: '2027-09-15', name: 'Mid-Autumn Festival', kind: 'cultural' },
  { day: '2028-10-03', name: 'Mid-Autumn Festival', kind: 'cultural' },
];

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`;

/** Day of month of the nth `weekday` (0 = Sunday) of a month; n = -1 is the last. */
function nthWeekday(
  year: number,
  month: number,
  weekday: number,
  n: number,
): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((last - weekday + 7) % 7);
}

function yearDates(year: number): CalendarDate[] {
  const h = (month: number, day: number, name: string): CalendarDate => ({
    day: ymd(year, month, day),
    name,
    kind: 'holiday',
  });
  return [
    h(1, 1, "New Year's Day"),
    h(1, nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day'),
    h(2, 14, "Valentine's Day"),
    h(2, nthWeekday(year, 2, 1, 3), "Presidents' Day"),
    h(5, nthWeekday(year, 5, 0, 2), "Mother's Day"),
    h(5, nthWeekday(year, 5, 1, -1), 'Memorial Day'),
    h(6, 19, 'Juneteenth'),
    h(6, nthWeekday(year, 6, 0, 3), "Father's Day"),
    h(7, 4, 'Independence Day'),
    h(9, nthWeekday(year, 9, 1, 1), 'Labor Day'),
    h(10, nthWeekday(year, 10, 1, 2), "Indigenous Peoples' Day"),
    h(10, 31, 'Halloween'),
    h(11, 11, 'Veterans Day'),
    h(11, nthWeekday(year, 11, 4, 4), 'Thanksgiving'),
    h(12, 24, 'Christmas Eve'),
    h(12, 25, 'Christmas Day'),
    h(12, 31, "New Year's Eve"),
  ];
}

/** Every date from `fromDay` through `toDay` (inclusive, YYYY-MM-DD), in day order. */
export function calendarDates(fromDay: string, toDay: string): CalendarDate[] {
  const fromYear = Number(fromDay.slice(0, 4));
  const toYear = Number(toDay.slice(0, 4));
  const all: CalendarDate[] = [...CULTURAL_DATES];
  for (let year = fromYear; year <= toYear; year += 1) {
    all.push(...yearDates(year));
  }
  return all
    .filter((d) => d.day >= fromDay && d.day <= toDay)
    .sort((a, b) => a.day.localeCompare(b.day));
}
