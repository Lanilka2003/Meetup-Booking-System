import { createHmac, timingSafeEqual } from 'node:crypto';

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { findMessageByProviderId, mirrorStatusToBooking, updateMessageStatus } from '../shared/db';
import { fromWhatsAppStatus } from '../shared/status';
import { getWhatsAppSecret } from '../shared/whatsapp';

/**
 * Public endpoint for Meta's WhatsApp webhooks (no Cognito auth — Meta can't
 * send a JWT). Instead:
 *   GET  → subscription handshake, checked against `verifyToken`
 *   POST → status updates, authenticated with the X-Hub-Signature-256 HMAC
 *          computed with the Meta `appSecret`.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  if (method === 'GET') return verifySubscription(event);
  if (method === 'POST') return receiveEvents(event);
  return { statusCode: 405, body: 'Method not allowed' };
}

async function verifySubscription(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {};
  const { verifyToken } = await getWhatsAppSecret();
  if (
    q['hub.mode'] === 'subscribe' &&
    verifyToken &&
    q['hub.verify_token'] &&
    safeEqual(q['hub.verify_token'], verifyToken)
  ) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: q['hub.challenge'] ?? '' };
  }
  return { statusCode: 403, body: 'Forbidden' };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function isValidSignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
  return safeEqual(header, expected);
}

interface WhatsAppStatusEvent {
  id: string;
  status: string;
  timestamp?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

interface WebhookPayload {
  entry?: { changes?: { field?: string; value?: { statuses?: WhatsAppStatusEvent[] } }[] }[];
}

async function receiveEvents(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  const { appSecret } = await getWhatsAppSecret();
  if (!appSecret) {
    console.error('Webhook rejected: appSecret missing from WhatsApp secret');
    return { statusCode: 503, body: 'Not configured' };
  }
  const signature = event.headers['x-hub-signature-256'] ?? event.headers['X-Hub-Signature-256'];
  if (!isValidSignature(raw, signature, appSecret)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw) as WebhookPayload;
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        await applyStatus(s).catch((error) =>
          // Log and continue: returning non-200 makes Meta retry the whole batch.
          console.error('Failed to apply webhook status', { id: s.id, error: (error as Error).message })
        );
      }
    }
  }
  // Always 200 quickly so Meta doesn't retry.
  return { statusCode: 200, body: 'OK' };
}

async function applyStatus(s: WhatsAppStatusEvent): Promise<void> {
  const status = fromWhatsAppStatus(s.status);
  if (!status) return;

  const message = await findMessageByProviderId(s.id);
  if (!message) return; // Not ours (e.g. sent from another tool on the same number).

  const at = s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : undefined;
  const err = s.errors?.[0];
  const failureReason = err
    ? `${err.title || err.message || 'Delivery failed'}${err.error_data?.details ? `: ${err.error_data.details}` : ''}${err.code ? ` (${err.code})` : ''}`
    : undefined;

  const changed = await updateMessageStatus(message.messageId, status, { at, failureReason });
  if (changed) await mirrorStatusToBooking(message.bookingId, message.messageId, status);
}
