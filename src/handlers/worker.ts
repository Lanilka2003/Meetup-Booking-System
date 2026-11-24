import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';

import {
  claimMessageForSend,
  getBooking,
  getTemplate,
  mirrorStatusToBooking,
  releaseSendClaim,
  updateMessageStatus,
} from '../shared/db';
import { templateVariables } from '../shared/templates';
import type { SendMessageJob } from '../shared/types';
import { sendTemplateMessage, WhatsAppError } from '../shared/whatsapp';

/** Must match `maxReceiveCount` on the queue's redrive policy (see lib/meetup-stack.ts). */
const MAX_ATTEMPTS = Number(process.env.MAX_SEND_ATTEMPTS || 3);

/**
 * Consumes send jobs from SQS and calls the WhatsApp Cloud API.
 *
 * - Idempotent: a message is atomically "claimed" while QUEUED, so SQS
 *   redelivery can never send the same WhatsApp twice.
 * - Retryable failures (429/5xx/network) are returned as batch item failures
 *   so SQS retries with backoff; on the last attempt the message is marked FAILED.
 * - Permanent failures (bad number, template not approved, …) are marked FAILED at once.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error('Send job failed; will retry', { id: record.messageId, error: (error as Error).message });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

async function markFailed(messageId: string, bookingId: string, reason: string): Promise<void> {
  if (await updateMessageStatus(messageId, 'FAILED', { failureReason: reason })) {
    await mirrorStatusToBooking(bookingId, messageId, 'FAILED');
  }
}

async function processRecord(record: SQSRecord): Promise<void> {
  let job: SendMessageJob;
  try {
    job = JSON.parse(record.body) as SendMessageJob;
  } catch {
    console.error('Dropping malformed job', record.messageId);
    return;
  }
  if (!job.messageId) return;

  const message = await claimMessageForSend(job.messageId);
  if (!message) {
    // Already sent/failed, or another invocation is sending it right now.
    console.log(JSON.stringify({ msg: 'Skip: message not claimable', messageId: job.messageId }));
    return;
  }

  const attempt = Number(record.attributes.ApproximateReceiveCount || 1);
  const isLastAttempt = attempt >= MAX_ATTEMPTS;

  const [booking, template] = await Promise.all([
    getBooking(message.bookingId),
    getTemplate(message.templateId),
  ]);
  if (!booking) return markFailed(message.messageId, message.bookingId, 'Booking no longer exists.');
  if (!template) return markFailed(message.messageId, message.bookingId, `Template "${message.templateId}" not found.`);

  try {
    const providerMessageId = await sendTemplateMessage(template, message.phone, templateVariables(booking));
    if (await updateMessageStatus(message.messageId, 'SENT', { providerMessageId })) {
      await mirrorStatusToBooking(message.bookingId, message.messageId, 'SENT');
    }
    console.log(JSON.stringify({ msg: 'WhatsApp sent', messageId: message.messageId, bookingId: message.bookingId }));
  } catch (error) {
    const err = error instanceof WhatsAppError ? error : new WhatsAppError((error as Error).message, true);
    if (err.retryable && !isLastAttempt) {
      await releaseSendClaim(message.messageId);
      throw err; // SQS will redeliver after the visibility timeout.
    }
    await markFailed(message.messageId, message.bookingId, err.message.slice(0, 500));
  }
}
