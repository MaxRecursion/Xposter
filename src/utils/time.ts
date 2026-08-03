/** Unix seconds at local midnight for the given date (defaults to today). */
export function startOfLocalDayUnix(date: Date = new Date()): number {
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0).getTime() / 1000,
  );
}
