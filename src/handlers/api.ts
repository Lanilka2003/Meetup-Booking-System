import { randomInt, randomUUID } from 'node:crypto';

import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

import {
  countCustomers,
  createBookingTransaction,
  getBooking,
  getTemplate,
  latestMessageForBooking,
  listBookings,
  listMessages,
  listTemplates,
  putMessage,
  setBookingMessage,
} from '../shared/db';
import { fail, HttpError, ok, paginate, parseJsonBody, parseLimit } from '../shared/http';
import { customerIdFor } from '../shared/phone';
import { enqueueSend } from '../shared/queue';
import { loadSettings, updateSettings } from '../shared/settings';
import { nowIso, todayISO } from '../shared/time';
import type {
  Booking,
  BookingDetails,
  CompanySettings,
  Message,
  MessageKind,
  MessageStatus,
} from '../shared/types';
import { validateCreateBooking, validateUpdateSettings } from '../shared/validation';
import { whatsappConnected } from '../shared/whatsapp';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

/**
 * Single Lambda serving every authenticated REST route. API Gateway's JWT
 * authorizer has already verified the Cognito access token before we run.
 */
export async function handler(event: Event): Promise<APIGatewayProxyResultV2> {
  try {
    const q = event.queryStringParameters ?? {};
    const id = event.pathParameters?.bookingId;

    switch (event.routeKey) {
      case 'GET /dashboard':
        return ok(await getDashboard());
      case 'GET /bookings':
        return ok(await getBookings(q));
      case 'POST /bookings':
        return ok(await createBooking(parseJsonBody(event.body, event.isBase64Encoded), userOf(event)), 201);
      case 'GET /bookings/{bookingId}':
        return ok(await getBookingDetails(requireId(id)));
      case 'POST /bookings/{bookingId}/resend':
        return ok(await resendBooking(requireId(id)), 202);
      case 'GET /messages':
        return ok(await getMessages(q));
      case 'GET /templates':
        return ok(await listTemplates());
      case 'GET /settings':
        return ok(await getSettings(event));
      case 'PUT /settings':
        await updateSettings(validateUpdateSettings(parseJsonBody(event.body, event.isBase64Encoded)));
        return ok(await getSettings(event));
      default:
        throw new HttpError(404, 'Route not found.');
    }
  } catch (error) {
    return fail(error);
  }
}

function requireId(id: string | undefined): string {
  if (!id || id.length > 64) throw new HttpError(400, 'A valid booking id is required.');
  return decodeURIComponent(id);
}

function userOf(event: Event): string {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  return String(claims.username ?? claims['cognito:username'] ?? claims.sub ?? 'unknown');
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function getDashboard() {
  const today = todayISO();
  const [todays, messages, totalCustomers, allBookings] = await Promise.all([
    listBookings({ from: today, to: today }),
    listMessages(),
    countCustomers(),
    listBookings(),
  ]);

  const count = (...statuses: MessageStatus[]) =>
    messages.filter((m) => statuses.includes(m.status)).length;

  const sent = count('SENT', 'DELIVERED', 'READ');
  const delivered = count('DELIVERED', 'READ');
  const failed = count('FAILED');
  const pending = count('QUEUED');

  const recentBookings = [...allBookings]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);

  return {
    stats: {
      todayBookings: todays.filter((b) => b.status !== 'CANCELLED').length,
      totalCustomers,
      messagesSent: sent,
      messagesPending: pending,
      messagesDelivered: delivered,
      messagesFailed: failed,
    },
    whatsappSummary: { sent, delivered, failed, pending },
    recentBookings,
  };
}

// ─── Bookings ────────────────────────────────────────────────────────────────

const BOOKING_FILTERS = ['today', 'upcoming', 'completed', 'cancelled', 'all'] as const;

async function getBookings(q: Record<string, string | undefined>) {
  const filter = q.filter?.trim().toLowerCase() || 'all';
  if (!BOOKING_FILTERS.includes(filter as (typeof BOOKING_FILTERS)[number])) {
    throw new HttpError(400, `Unknown filter "${filter}".`);
  }
  const today = todayISO();

  let list: Booking[];
  switch (filter) {
    case 'today':
      list = await listBookings({ from: today, to: today });
      break;
    case 'upcoming':
      list = (await listBookings({ from: today })).filter(
        (b) => b.status !== 'CANCELLED' && b.status !== 'COMPLETED'
      );
      break;
    case 'completed':
      list = (await listBookings()).filter((b) => b.status === 'COMPLETED');
      break;
    case 'cancelled':
      list = (await listBookings()).filter((b) => b.status === 'CANCELLED');
      break;
    default:
      list = await listBookings();
  }

  const search = q.search?.trim().toLowerCase();
  if (search) {
    const digits = search.replace(/\D/g, '');
    list = list.filter(
      (b) =>
        b.customerName.toLowerCase().includes(search) ||
        b.bookingId.toLowerCase().includes(search) ||
        (digits.length >= 3 && b.phone.replace(/\D/g, '').includes(digits.replace(/^0/, '')))
    );
  }

  // GSI already returns slot order (date, time) ascending.
  return paginate(list, parseLimit(q.limit), q.nextToken);
}

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newBookingId(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return `MB-${s}`;
}

function newMessage(booking: Booking, templateId: string, kind: MessageKind): Message {
  const now = nowIso();
  return {
    messageId: randomUUID(),
    bookingId: booking.bookingId,
    customerName: booking.customerName,
    phone: booking.phone,
    templateId,
    kind,
    status: 'QUEUED',
    queuedAt: now,
    createdAt: now,
    attempts: 0,
  };
}

async function createBooking(body: unknown, createdBy: string): Promise<BookingDetails> {
  const input = validateCreateBooking(body);

  const template = await getTemplate(input.templateId);
  if (!template) throw new HttpError(422, 'The selected template does not exist.', 'VALIDATION_ERROR');
  if (!template.active) throw new HttpError(422, 'The selected template is inactive.', 'VALIDATION_ERROR');

  const settings = await loadSettings();
  const autoSend = settings.automation.whatsappAutomation && settings.automation.bookingConfirmation;

  for (let attempt = 0; attempt < 3; attempt++) {
    const now = nowIso();
    const booking: Booking = {
      bookingId: newBookingId(),
      customerId: customerIdFor(input.phone),
      customerName: input.customerName,
      phone: input.phone,
      date: input.date,
      time: input.time,
      status: 'CONFIRMED',
      templateId: input.templateId,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
      createdBy,
    };
    const message = autoSend ? newMessage(booking, input.templateId, 'confirmation') : undefined;
    if (message) {
      booking.messageId = message.messageId;
      booking.whatsappStatus = 'QUEUED';
    }

    try {
      await createBookingTransaction(booking, message);
    } catch (error) {
      // Booking id collision (1 in ~10^9) → retry with a fresh id.
      if ((error as Error).name === 'TransactionCanceledException' && attempt < 2) continue;
      throw error;
    }

    if (message) {
      const queued = await enqueueSend(message.messageId);
      if (!queued) booking.whatsappStatus = 'FAILED';
    }
    return {
      ...booking,
      queuedAt: message?.queuedAt,
      ...(booking.whatsappStatus === 'FAILED'
        ? { failureReason: 'Could not queue the message. Please resend.' }
        : {}),
    };
  }
  throw new HttpError(500, 'Could not create the booking. Please try again.');
}

async function getBookingDetails(bookingId: string): Promise<BookingDetails> {
  const booking = await getBooking(bookingId);
  if (!booking) throw new HttpError(404, 'Booking not found.');
  const message = await latestMessageForBooking(bookingId);
  if (!message) return booking;
  return {
    ...booking,
    messageId: message.messageId,
    whatsappStatus: message.status,
    providerMessageId: message.providerMessageId,
    queuedAt: message.queuedAt,
    sentAt: message.sentAt,
    deliveredAt: message.deliveredAt,
    failedAt: message.failedAt,
    failureReason: message.failureReason,
  };
}

async function resendBooking(bookingId: string): Promise<{ status: MessageStatus; messageId: string }> {
  const booking = await getBooking(bookingId);
  if (!booking) throw new HttpError(404, 'Booking not found.');

  const latest = await latestMessageForBooking(bookingId);
  if (latest?.status === 'QUEUED') {
    throw new HttpError(409, 'A WhatsApp message for this booking is already queued.', 'ALREADY_QUEUED');
  }

  const templateId = booking.templateId || 'booking_confirmation';
  const template = await getTemplate(templateId);
  if (!template) throw new HttpError(422, 'The booking template no longer exists.');

  const message = newMessage(booking, templateId, 'resend');
  await putMessage(message);
  await setBookingMessage(bookingId, message.messageId, 'QUEUED');
  const queued = await enqueueSend(message.messageId);
  if (!queued) {
    await setBookingMessage(bookingId, message.messageId, 'FAILED');
    throw new HttpError(503, 'Could not queue the message. Please try again.', 'QUEUE_UNAVAILABLE');
  }
  return { status: 'QUEUED', messageId: message.messageId };
}

// ─── Messages ────────────────────────────────────────────────────────────────

const MESSAGE_STATUSES: MessageStatus[] = ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'];

async function getMessages(q: Record<string, string | undefined>) {
  let list = await listMessages();

  const filter = q.filter?.trim().toUpperCase();
  if (filter && filter !== 'ALL') {
    if (!MESSAGE_STATUSES.includes(filter as MessageStatus)) {
      throw new HttpError(400, `Unknown filter "${q.filter}".`);
    }
    list = list.filter((m) => m.status === filter);
  }

  const search = q.search?.trim().toLowerCase();
  if (search) {
    const digits = search.replace(/\D/g, '');
    list = list.filter(
      (m) =>
        m.customerName.toLowerCase().includes(search) ||
        m.templateId.toLowerCase().includes(search) ||
        m.bookingId.toLowerCase().includes(search) ||
        (digits.length >= 3 && m.phone.replace(/\D/g, '').includes(digits.replace(/^0/, '')))
    );
  }

  return paginate(
    list.map(({ attempts: _a, kind: _k, ...rest }) => rest),
    parseLimit(q.limit),
    q.nextToken
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

const cognito = new CognitoIdentityProviderClient({});

async function accountInfo(event: Event) {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const groups = String(claims['cognito:groups'] ?? '')
    .replace(/[[\]]/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
  const role = groups.some((g) => g.toLowerCase() === 'owner') ? 'Owner' : 'Staff';
  const username = userOf(event);

  // GetUser is authorised by the caller's own access token — no IAM permission needed.
  const token = (event.headers.authorization ?? event.headers.Authorization ?? '').replace(/^Bearer\s+/i, '');
  try {
    const user = await cognito.send(new GetUserCommand({ AccessToken: token }));
    const attr = (name: string) => user.UserAttributes?.find((a) => a.Name === name)?.Value;
    const mfaList = user.UserMFASettingList ?? [];
    return {
      account: { name: attr('name') || username, email: attr('email') || '', role },
      security: {
        mfaEnabled: mfaList.length > 0,
        mfaConfigured: mfaList.includes('SOFTWARE_TOKEN_MFA'),
      },
    };
  } catch (error) {
    console.warn('GetUser failed', (error as Error).name);
    return {
      account: { name: username, email: String(claims.email ?? ''), role },
      security: { mfaEnabled: false, mfaConfigured: false },
    };
  }
}

async function getSettings(event: Event): Promise<CompanySettings> {
  const [stored, info, connected] = await Promise.all([
    loadSettings(),
    accountInfo(event),
    whatsappConnected(),
  ]);
  return {
    account: info.account,
    company: {
      companyName: stored.companyName,
      whatsappBusinessNumber: stored.whatsappBusinessNumber,
      whatsappConnected: connected,
    },
    automation: stored.automation,
    notifications: stored.notifications,
    security: info.security,
  };
}
