/**
 * Calendar helpers. Bookings store a local date ("YYYY-MM-DD") and time ("HH:MM")
 * in the business timezone (Asia/Colombo by default), so "today" must be computed
 * in that timezone — not in the Lambda's UTC clock.
 */

export const TIMEZONE = process.env.TIMEZONE || 'Asia/Colombo';

/** Today's date in the business timezone as YYYY-MM-DD. */
export function todayISO(now: Date = new Date(), timeZone: string = TIMEZONE): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Human date for WhatsApp messages, e.g. "Monday, 9 November 2026". */
export function formatDateLong(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "14:30" → "2:30 PM". */
export function formatTime12h(time: string): string {
  const [h, min] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(min).padStart(2, '0')} ${suffix}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
