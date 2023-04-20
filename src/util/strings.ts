import dayjs from 'dayjs';

export function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function stringToDate(dateStr: string): dayjs.Dayjs | undefined {
  // Create a regular expression to match the YYYY/MM/DD format
  const regex = /^\d{4}\/\d{2}\/\d{2}$/;

  // Test if the string matches the regular expression
  if (!regex.test(dateStr)) {
    return undefined;
  }

  const date = dayjs(dateStr, 'YYYY/MM/DD');

  if (!date.isValid()) {
    return undefined;
  }

  return date;
}
