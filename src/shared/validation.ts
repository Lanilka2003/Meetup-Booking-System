import { HttpError } from './http';
import { toE164 } from './phone';
import { addDays, isValidISODate, isValidTime, todayISO } from './time';
import type { AutomationSettings, NotificationSettings } from './types';

export interface CreateBookingInput {
  customerName: string;
  phone: string;
  date: string;
  time: string;
  templateId: string;
  notes?: string;
}

export interface UpdateSettingsInput {
  automation?: Partial<AutomationSettings>;
  notifications?: Partial<NotificationSettings>;
}

const MAX_NAME = 80;
const MAX_NOTES = 500;
/** Bookings can't be created further out than this. */
const MAX_DAYS_AHEAD = 365;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalise a POST /bookings body. Throws a 422 HttpError whose
 * `details` maps field → message, so the app could show inline errors.
 */
export function validateCreateBooking(body: unknown, today: string = todayISO()): CreateBookingInput {
  if (!isObject(body)) throw new HttpError(400, 'Request body must be a JSON object.');

  const errors: Record<string, string> = {};
  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '');

  const customerName = str('customerName').replace(/\s+/g, ' ');
  if (!customerName) errors.customerName = 'Customer name is required.';
  else if (customerName.length < 2) errors.customerName = 'Customer name is too short.';
  else if (customerName.length > MAX_NAME) errors.customerName = `Customer name must be at most ${MAX_NAME} characters.`;

  const phone = toE164(str('phone'));
  if (!phone) errors.phone = 'Enter a valid Sri Lankan mobile number.';

  const date = str('date');
  if (!isValidISODate(date)) errors.date = 'Date must be a valid date (YYYY-MM-DD).';
  else if (date < today) errors.date = 'Date cannot be in the past.';
  else if (date > addDays(today, MAX_DAYS_AHEAD)) errors.date = 'Date is too far in the future.';

  const time = str('time');
  if (!isValidTime(time)) errors.time = 'Time must be in 24h HH:MM format.';

  const templateId = str('templateId');
  if (!templateId) errors.templateId = 'Select a WhatsApp template.';
  else if (!/^[a-z0-9_]{1,64}$/.test(templateId)) errors.templateId = 'Invalid template.';

  const notes = str('notes');
  if (notes.length > MAX_NOTES) errors.notes = `Notes must be at most ${MAX_NOTES} characters.`;

  if (Object.keys(errors).length > 0) {
    throw new HttpError(422, Object.values(errors)[0], 'VALIDATION_ERROR', errors);
  }

  return { customerName, phone: phone!, date, time, templateId, notes: notes || undefined };
}

const AUTOMATION_KEYS: (keyof AutomationSettings)[] = [
  'whatsappAutomation',
  'bookingConfirmation',
  'bookingReminder',
];
const NOTIFICATION_KEYS: (keyof NotificationSettings)[] = [
  'pushNotifications',
  'messageDeliveryNotifications',
];

/** Validate a PUT /settings body. Only known boolean toggles are accepted. */
export function validateUpdateSettings(body: unknown): UpdateSettingsInput {
  if (!isObject(body)) throw new HttpError(400, 'Request body must be a JSON object.');

  const pick = <K extends string>(section: string, keys: K[]): Partial<Record<K, boolean>> | undefined => {
    const value = body[section];
    if (value === undefined) return undefined;
    if (!isObject(value)) throw new HttpError(422, `"${section}" must be an object.`);
    const out: Partial<Record<K, boolean>> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!keys.includes(k as K)) throw new HttpError(422, `Unknown setting "${section}.${k}".`);
      if (typeof v !== 'boolean') throw new HttpError(422, `"${section}.${k}" must be true or false.`);
      out[k as K] = v;
    }
    return out;
  };

  const automation = pick('automation', AUTOMATION_KEYS);
  const notifications = pick('notifications', NOTIFICATION_KEYS);
  if (!automation && !notifications) {
    throw new HttpError(422, 'Nothing to update. Send "automation" and/or "notifications".');
  }
  return { automation, notifications };
}
