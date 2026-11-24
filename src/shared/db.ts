import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

import type {
  Booking,
  Customer,
  Message,
  MessageStatus,
  MessageTemplate,
  StoredSettings,
} from './types';
import { allowedPreviousStatuses } from './status';

/**
 * DynamoDB data access. Four tables (names injected by CDK as env vars):
 *
 *  Customers  PK customerId                (customerId derives from phone → natural upsert)
 *  Bookings   PK bookingId
 *             GSI byDate     PK entity="BOOKING"  SK slot="YYYY-MM-DD#HH:MM#bookingId"
 *  Messages   PK messageId
 *             GSI byCreated  PK entity="MESSAGE"  SK createdAt
 *             GSI byBooking  PK bookingId         SK createdAt
 *             GSI byProvider PK providerMessageId                (WhatsApp webhook lookups)
 *  Config     PK pk  ("TEMPLATE#<id>" | "SETTINGS")
 */

export const TABLES = {
  customers: process.env.CUSTOMERS_TABLE ?? 'Customers',
  bookings: process.env.BOOKINGS_TABLE ?? 'Bookings',
  messages: process.env.MESSAGES_TABLE ?? 'Messages',
  config: process.env.CONFIG_TABLE ?? 'Config',
};

export const INDEXES = {
  bookingsByDate: 'byDate',
  messagesByCreated: 'byCreated',
  messagesByBooking: 'byBooking',
  messagesByProvider: 'byProvider',
};

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const BOOKING_ENTITY = 'BOOKING';
const MESSAGE_ENTITY = 'MESSAGE';
const SETTINGS_PK = 'SETTINGS';
const templatePk = (id: string) => `TEMPLATE#${id}`;

export function bookingSlot(b: Pick<Booking, 'date' | 'time' | 'bookingId'>): string {
  return `${b.date}#${b.time}#${b.bookingId}`;
}

/** Strip storage-only attributes before returning items to the API. */
function clean<T extends object>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined;
  const { entity: _e, slot: _s, pk: _p, ...rest } = item;
  return rest as T;
}

async function queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...((out.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// ─── Bookings ────────────────────────────────────────────────────────────────

export async function getBooking(bookingId: string): Promise<Booking | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: TABLES.bookings, Key: { bookingId } }));
  return clean<Booking>(out.Item);
}

/**
 * Bookings in slot order. `from`/`to` are inclusive YYYY-MM-DD bounds.
 * The meetup has at most a few thousand bookings, so list endpoints load the
 * date range and filter/search in memory — simple, consistent and cheap.
 */
export async function listBookings(range: { from?: string; to?: string } = {}): Promise<Booking[]> {
  const names = { '#e': 'entity', '#s': 'slot' };
  const values: Record<string, unknown> = { ':e': BOOKING_ENTITY };
  let condition = '#e = :e';
  if (range.from && range.to) {
    condition += ' AND #s BETWEEN :from AND :to';
    values[':from'] = range.from;
    values[':to'] = `${range.to}#~`;
  } else if (range.from) {
    condition += ' AND #s >= :from';
    values[':from'] = range.from;
  } else if (range.to) {
    condition += ' AND #s <= :to';
    values[':to'] = `${range.to}#~`;
  }
  const items = await queryAll({
    TableName: TABLES.bookings,
    IndexName: INDEXES.bookingsByDate,
    KeyConditionExpression: condition,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  });
  return items.map((i) => clean<Booking>(i)!);
}

/**
 * Create a booking atomically with its customer upsert and (optionally) the
 * QUEUED message row. The SQS enqueue happens after the commit; the worker is
 * idempotent on messageId so a retry can never double-send.
 */
export async function createBookingTransaction(
  booking: Booking,
  message: Message | undefined
): Promise<void> {
  const now = booking.createdAt;
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLES.bookings,
            Item: { ...booking, entity: BOOKING_ENTITY, slot: bookingSlot(booking) },
            ConditionExpression: 'attribute_not_exists(bookingId)',
          },
        },
        {
          Update: {
            TableName: TABLES.customers,
            Key: { customerId: booking.customerId },
            UpdateExpression:
              'SET #n = :name, phone = :phone, updatedAt = :now, createdAt = if_not_exists(createdAt, :now) ADD bookingCount :one',
            ExpressionAttributeNames: { '#n': 'name' },
            ExpressionAttributeValues: {
              ':name': booking.customerName,
              ':phone': booking.phone,
              ':now': now,
              ':one': 1,
            },
          },
        },
        ...(message
          ? [
              {
                Put: {
                  TableName: TABLES.messages,
                  Item: { ...message, entity: MESSAGE_ENTITY },
                  ConditionExpression: 'attribute_not_exists(messageId)',
                },
              },
            ]
          : []),
      ],
    })
  );
}

/** Point the booking at its latest WhatsApp message and mirror its status. */
export async function setBookingMessage(
  bookingId: string,
  messageId: string,
  status: MessageStatus,
  extra: { reminderSentAt?: string } = {}
): Promise<void> {
  const sets = ['messageId = :m', 'whatsappStatus = :s', 'updatedAt = :now'];
  const values: Record<string, unknown> = { ':m': messageId, ':s': status, ':now': new Date().toISOString() };
  if (extra.reminderSentAt) {
    sets.push('reminderSentAt = :r');
    values[':r'] = extra.reminderSentAt;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.bookings,
      Key: { bookingId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(bookingId)',
      ExpressionAttributeValues: values,
    })
  );
}

/** Mark a booking's reminder as sent. Returns false if a reminder was already claimed. */
export async function claimReminder(bookingId: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.bookings,
        Key: { bookingId },
        UpdateExpression: 'SET reminderSentAt = :now',
        ConditionExpression: 'attribute_exists(bookingId) AND attribute_not_exists(reminderSentAt)',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      })
    );
    return true;
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

/** Mirror a message status onto the booking — only if it is still the booking's latest message. */
export async function mirrorStatusToBooking(
  bookingId: string,
  messageId: string,
  status: MessageStatus
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.bookings,
        Key: { bookingId },
        UpdateExpression: 'SET whatsappStatus = :s, updatedAt = :now',
        ConditionExpression: 'messageId = :m',
        ExpressionAttributeValues: { ':s': status, ':m': messageId, ':now': new Date().toISOString() },
      })
    );
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
  }
}

// ─── Customers ───────────────────────────────────────────────────────────────

export async function countCustomers(): Promise<number> {
  let count = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({ TableName: TABLES.customers, Select: 'COUNT', ExclusiveStartKey })
    );
    count += out.Count ?? 0;
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

export async function getCustomer(customerId: string): Promise<Customer | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: TABLES.customers, Key: { customerId } }));
  return out.Item as Customer | undefined;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function putMessage(message: Message): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLES.messages,
      Item: { ...message, entity: MESSAGE_ENTITY },
      ConditionExpression: 'attribute_not_exists(messageId)',
    })
  );
}

export async function getMessage(messageId: string): Promise<Message | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: TABLES.messages, Key: { messageId } }));
  return clean<Message>(out.Item);
}

/** All messages, newest first. */
export async function listMessages(): Promise<Message[]> {
  const items = await queryAll({
    TableName: TABLES.messages,
    IndexName: INDEXES.messagesByCreated,
    KeyConditionExpression: '#e = :e',
    ExpressionAttributeNames: { '#e': 'entity' },
    ExpressionAttributeValues: { ':e': MESSAGE_ENTITY },
    ScanIndexForward: false,
  });
  return items.map((i) => clean<Message>(i)!);
}

export async function latestMessageForBooking(bookingId: string): Promise<Message | undefined> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: TABLES.messages,
      IndexName: INDEXES.messagesByBooking,
      KeyConditionExpression: 'bookingId = :b',
      ExpressionAttributeValues: { ':b': bookingId },
      ScanIndexForward: false,
      Limit: 1,
    })
  );
  return clean<Message>(out.Items?.[0] as Record<string, unknown> | undefined);
}

export async function findMessageByProviderId(providerMessageId: string): Promise<Message | undefined> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: TABLES.messages,
      IndexName: INDEXES.messagesByProvider,
      KeyConditionExpression: 'providerMessageId = :p',
      ExpressionAttributeValues: { ':p': providerMessageId },
      Limit: 1,
    })
  );
  return clean<Message>(out.Items?.[0] as Record<string, unknown> | undefined);
}

const STATUS_TIMESTAMP: Partial<Record<MessageStatus, keyof Message>> = {
  QUEUED: 'queuedAt',
  SENT: 'sentAt',
  DELIVERED: 'deliveredAt',
  READ: 'readAt',
  FAILED: 'failedAt',
};

/**
 * Advance a message's status. Returns false when the transition was ignored
 * because the message is already at (or past) that status.
 *
 * Allowed: forward moves along QUEUED→SENT→DELIVERED→READ, any → FAILED except
 * from DELIVERED/READ, and FAILED → QUEUED only when `allowRequeue` (manual resend).
 */
export async function updateMessageStatus(
  messageId: string,
  status: MessageStatus,
  opts: { at?: string; providerMessageId?: string; failureReason?: string; allowRequeue?: boolean } = {}
): Promise<boolean> {
  const at = opts.at ?? new Date().toISOString();
  const names: Record<string, string> = { '#st': 'status' };
  const values: Record<string, unknown> = { ':st': status };
  const sets = ['#st = :st'];
  const removes: string[] = [];

  const tsField = STATUS_TIMESTAMP[status];
  if (tsField) {
    sets.push(`${tsField} = :at`);
    values[':at'] = at;
  }
  if (opts.providerMessageId) {
    sets.push('providerMessageId = :pid');
    values[':pid'] = opts.providerMessageId;
  }
  if (status === 'FAILED') {
    sets.push('failureReason = :fr');
    values[':fr'] = opts.failureReason ?? 'Unknown error';
  } else {
    removes.push('failureReason', 'failedAt');
  }

  const allowedFrom = allowedPreviousStatuses(status, opts.allowRequeue);
  if (allowedFrom.length === 0) return false;

  const fromKeys = allowedFrom.map((s, i) => {
    values[`:from${i}`] = s;
    return `:from${i}`;
  });

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.messages,
        Key: { messageId },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ConditionExpression: `attribute_exists(messageId) AND #st IN (${fromKeys.join(', ')})`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

/** Atomically claim a QUEUED message for sending (prevents duplicate sends on SQS redelivery). */
export async function claimMessageForSend(messageId: string): Promise<Message | undefined> {
  try {
    const out = await ddb.send(
      new UpdateCommand({
        TableName: TABLES.messages,
        Key: { messageId },
        UpdateExpression: 'SET attempts = if_not_exists(attempts, :zero) + :one, sendingAt = :now',
        ConditionExpression:
          '#st = :queued AND (attribute_not_exists(sendingAt) OR sendingAt < :stale)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':queued': 'QUEUED',
          ':zero': 0,
          ':one': 1,
          ':now': new Date().toISOString(),
          // A claim older than 5 minutes is considered abandoned (Lambda crashed mid-send).
          ':stale': new Date(Date.now() - 5 * 60_000).toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    return clean<Message>(out.Attributes);
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') return undefined;
    throw error;
  }
}

export async function releaseSendClaim(messageId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.messages,
      Key: { messageId },
      UpdateExpression: 'REMOVE sendingAt',
    })
  );
}

// ─── Config: templates + settings ────────────────────────────────────────────

export async function listTemplates(): Promise<MessageTemplate[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: TABLES.config,
        FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': 'TEMPLATE#' },
        ExclusiveStartKey,
      })
    );
    items.push(...((out.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items
    .map((i) => clean<MessageTemplate>(i)!)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

export async function getTemplate(templateId: string): Promise<MessageTemplate | undefined> {
  const out = await ddb.send(
    new GetCommand({ TableName: TABLES.config, Key: { pk: templatePk(templateId) } })
  );
  return clean<MessageTemplate>(out.Item);
}

export async function putTemplate(template: MessageTemplate, overwrite = true): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLES.config,
        Item: { ...template, pk: templatePk(template.templateId) },
        ...(overwrite ? {} : { ConditionExpression: 'attribute_not_exists(pk)' }),
      })
    );
    return true;
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

export async function getStoredSettings(): Promise<StoredSettings | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: TABLES.config, Key: { pk: SETTINGS_PK } }));
  return clean<StoredSettings>(out.Item);
}

export async function putStoredSettings(settings: StoredSettings, overwrite = true): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLES.config,
        Item: { ...settings, pk: SETTINGS_PK },
        ...(overwrite ? {} : { ConditionExpression: 'attribute_not_exists(pk)' }),
      })
    );
    return true;
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}
