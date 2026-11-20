// Recurring savings schedules — pure date logic (harness-covered in
// scripts/savings-schedules-test.mjs). A schedule moves a fixed amount
// into a pot on its due date: "once" applies a single time, "monthly"
// every month, "yearly" every year. Dates are yyyy-mm-dd strings;
// "today" is always IST (todayStrIst), because the user lives in IST
// and a schedule due today must not wait for UTC midnight.
export type ScheduleFrequency = "once" | "monthly" | "yearly";

export const SCHEDULE_FREQUENCIES: ScheduleFrequency[] = ["once", "monthly", "yearly"];

export function isScheduleFrequency(v: string): v is ScheduleFrequency {
  return v === "once" || v === "monthly" || v === "yearly";
}

export function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daysInMonth(year: number, month: number): number {
  // month is 1-based; day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The next due date after `date` for a frequency, or null when there
 *  is no next one ("once"). Monthly/yearly clamp the day to the target
 *  month (31 Jan → 28 Feb; 29 Feb → 28 Feb in a non-leap year) and the
 *  clamped day then sticks for later periods. */
export function nextDueDateAfter(date: string, frequency: ScheduleFrequency): string | null {
  if (!isValidDateStr(date)) return null;
  if (frequency === "once") return null;
  const [y, m, d] = date.split("-").map(Number);
  const ny = frequency === "yearly" ? y + 1 : y + Math.floor(m / 12);
  const nm = frequency === "yearly" ? m : (m % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** True when a schedule dated `nextDueDate` is due on (or before) `today`. */
export function isDue(nextDueDate: string, today: string): boolean {
  return isValidDateStr(nextDueDate) && isValidDateStr(today) && nextDueDate <= today;
}
