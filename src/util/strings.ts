export function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function stringToDate(dateStr: string): Date | undefined {
  // Create a regular expression to match the YYYY/MM/DD format
  const regex = /^\d{4}\/\d{2}\/\d{2}$/;

  // Test if the string matches the regular expression
  if (!regex.test(dateStr)) {
    return undefined;
  }

  // Split the string into year, month, and day components
  const [yearStr, monthStr, dayStr] = dateStr.split('/');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  // Create a new date object from the year, month, and day components
  return new Date(year, month - 1, day);
}

export function dateChecker(dateStr: string): boolean {
  // Create a new date object from the year, month, and day components
  const date = stringToDate(dateStr);
  if (!date) {
    return false;
  }

  // Use the isNaN function to check if the date is valid
  return !Number.isNaN(date.getTime());
}
