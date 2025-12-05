import dayjs, { Dayjs } from 'dayjs';
import LocalizedFormat from 'dayjs/plugin/localizedFormat';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(LocalizedFormat);

// TODO: Get timezone from Meetup group instead
export function tz(dt: Dayjs, tzName = 'America/Los_Angeles'): Dayjs {
  return dt.tz(tzName);
}
