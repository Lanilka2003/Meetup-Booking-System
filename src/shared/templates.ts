import type { Booking, MessageTemplate } from './types';
import { formatDateLong, formatTime12h } from './time';

/**
 * Default WhatsApp templates seeded into DynamoDB (`npm run seed`).
 *
 * IMPORTANT: Business-initiated WhatsApp messages must use a template that
 * Meta has approved. Create templates in WhatsApp Manager with the SAME name
 * as `templateId` and NAMED parameters: customer_name, date, time, booking_id.
 */
export const DEFAULT_TEMPLATES: MessageTemplate[] = [
  {
    templateId: 'booking_confirmation',
    name: 'Booking Confirmation',
    description: 'Sent immediately after a booking is created.',
    body: 'Hello {{customer_name}}, your booking with Mahaguru Meet Up is confirmed for {{date}} at {{time}}. Booking ID: {{booking_id}}. Om 🙏',
    active: true,
    category: 'confirmation',
    language: 'en',
  },
  {
    templateId: 'booking_reminder',
    name: 'Booking Reminder',
    description: 'Automatic reminder the day before the booking.',
    body: 'Hello {{customer_name}}, this is a friendly reminder of your booking on {{date}} at {{time}}. Booking ID: {{booking_id}}. We look forward to seeing you. Om 🙏',
    active: true,
    category: 'reminder',
    language: 'en',
  },
  {
    templateId: 'booking_rescheduled',
    name: 'Booking Rescheduled',
    description: 'Notify the customer when a booking is rescheduled.',
    body: 'Hello {{customer_name}}, your booking has been rescheduled to {{date}} at {{time}}. Booking ID: {{booking_id}}. Thank you. Om 🙏',
    active: true,
    category: 'reschedule',
    language: 'en',
  },
  {
    templateId: 'booking_cancelled',
    name: 'Booking Cancelled',
    description: 'Notify the customer when a booking is cancelled.',
    body: 'Hello {{customer_name}}, unfortunately your booking on {{date}} at {{time}} has been cancelled. Booking ID: {{booking_id}}. Please contact us to rebook. Om 🙏',
    active: true,
    category: 'cancellation',
    language: 'en',
  },
  {
    templateId: 'thank_you',
    name: 'Thank You',
    description: 'Thank a customer after a completed booking.',
    body: 'Thank you {{customer_name}} for visiting Mahaguru Meet Up. We wish you peace and wellness. Om 🙏',
    active: false,
    category: 'appreciation',
    language: 'en',
  },
];

export const REMINDER_TEMPLATE_ID = 'booking_reminder';

const VARIABLE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Values available to templates, keyed by variable name. */
export function templateVariables(
  booking: Pick<Booking, 'customerName' | 'date' | 'time' | 'bookingId'>
): Record<string, string> {
  return {
    customer_name: booking.customerName,
    date: formatDateLong(booking.date),
    time: formatTime12h(booking.time),
    booking_id: booking.bookingId,
  };
}

/** Names of the `{{variables}}` used in a template body, in order of first use. */
export function variablesIn(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(VARIABLE)) seen.add(match[1].toLowerCase());
  return [...seen];
}

/** Fill `{{variables}}` in a template body. Unknown variables are left blank. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(VARIABLE, (_, name: string) => vars[name.toLowerCase()] ?? '');
}
