import { randomUUID } from 'node:crypto';

import { claimReminder, getTemplate, listBookings, putMessage, setBookingMessage } from '../shared/db';
import { enqueueSend } from '../shared/queue';
import { loadSettings } from '../shared/settings';
import { REMINDER_TEMPLATE_ID } from '../shared/templates';
import { addDays, nowIso, todayISO } from '../shared/time';
import type { Message } from '../shared/types';

/**
 * Runs once a day (EventBridge schedule) and queues a WhatsApp reminder for
 * every active booking happening tomorrow. Controlled by Settings →
 * "WhatsApp automation" + "Booking reminder". Each booking gets at most one
 * reminder (`reminderSentAt` is claimed atomically), so re-runs are safe.
 */
export async function handler(): Promise<{ queued: number; skipped: string }> {
  const settings = await loadSettings();
  if (!settings.automation.whatsappAutomation || !settings.automation.bookingReminder) {
    return { queued: 0, skipped: 'reminders disabled in settings' };
  }

  const template = await getTemplate(REMINDER_TEMPLATE_ID);
  if (!template?.active) {
    return { queued: 0, skipped: `template "${REMINDER_TEMPLATE_ID}" missing or inactive` };
  }

  const tomorrow = addDays(todayISO(), 1);
  const bookings = (await listBookings({ from: tomorrow, to: tomorrow })).filter(
    (b) => (b.status === 'CONFIRMED' || b.status === 'RESCHEDULED') && !b.reminderSentAt
  );

  let queued = 0;
  for (const booking of bookings) {
    if (!(await claimReminder(booking.bookingId))) continue;
    const now = nowIso();
    const message: Message = {
      messageId: randomUUID(),
      bookingId: booking.bookingId,
      customerName: booking.customerName,
      phone: booking.phone,
      templateId: REMINDER_TEMPLATE_ID,
      kind: 'reminder',
      status: 'QUEUED',
      queuedAt: now,
      createdAt: now,
      attempts: 0,
    };
    await putMessage(message);
    await setBookingMessage(booking.bookingId, message.messageId, 'QUEUED');
    if (await enqueueSend(message.messageId)) queued++;
  }

  console.log(JSON.stringify({ msg: 'Reminders queued', date: tomorrow, queued, candidates: bookings.length }));
  return { queued, skipped: '' };
}
