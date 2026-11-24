import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer, SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';

process.env.WHATSAPP_SECRET_ARN = 'arn:aws:secretsmanager:test';
process.env.SEND_QUEUE_URL = 'https://sqs.test/queue';

import { handler as api } from '../src/handlers/api';
import { handler as webhook } from '../src/handlers/webhook';
import { handler as worker } from '../src/handlers/worker';
import { DEFAULT_TEMPLATES } from '../src/shared/templates';
import { addDays, todayISO } from '../src/shared/time';

const ddb = mockClient(DynamoDBDocumentClient);
const sqs = mockClient(SQSClient);
const secrets = mockClient(SecretsManagerClient);

const SECRET = { accessToken: 'token', phoneNumberId: '123', appSecret: 'app-secret', verifyToken: 'verify' };

function apiEvent(routeKey: string, init: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {}) {
  return {
    routeKey,
    headers: { authorization: 'Bearer test' },
    requestContext: { authorizer: { jwt: { claims: { username: 'owner' }, scopes: [] } } },
    ...init,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function body(res: unknown) {
  return JSON.parse((res as { body: string }).body);
}

beforeEach(() => {
  ddb.reset();
  sqs.reset();
  secrets.reset();
  secrets.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify(SECRET) });
});

afterEach(() => mock.restoreAll());

describe('POST /bookings', () => {
  it('writes booking + customer + QUEUED message in one transaction, then enqueues', async () => {
    ddb.on(GetCommand, { Key: { pk: 'TEMPLATE#booking_confirmation' } }).resolves({
      Item: { ...DEFAULT_TEMPLATES[0], pk: 'TEMPLATE#booking_confirmation' },
    });
    ddb.on(GetCommand, { Key: { pk: 'SETTINGS' } }).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    sqs.on(SendMessageCommand).resolves({});

    const res = await api(
      apiEvent('POST /bookings', {
        body: JSON.stringify({
          customerName: 'Nimal Jayasuriya',
          phone: '071 233 5678',
          date: addDays(todayISO(), 1),
          time: '09:00',
          templateId: 'booking_confirmation',
        }),
      })
    );

    const json = body(res);
    assert.equal((res as { statusCode: number }).statusCode, 201, JSON.stringify(json));
    assert.equal(json.success, true);
    assert.match(json.data.bookingId, /^MB-[A-Z2-9]{6}$/);
    assert.equal(json.data.phone, '+94712335678');
    assert.equal(json.data.whatsappStatus, 'QUEUED');

    const tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    assert.equal(tx.length, 3);
    assert.equal(tx[0].Put!.Item!.slot, `${json.data.date}#09:00#${json.data.bookingId}`);
    assert.equal(tx[1].Update!.Key!.customerId, 'cust-94712335678');
    assert.equal(tx[2].Put!.Item!.status, 'QUEUED');

    const job = JSON.parse(sqs.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!);
    assert.equal(job.messageId, json.data.messageId);
  });

  it('skips the WhatsApp message when automation is off', async () => {
    ddb.on(GetCommand, { Key: { pk: 'TEMPLATE#booking_confirmation' } }).resolves({ Item: DEFAULT_TEMPLATES[0] });
    ddb.on(GetCommand, { Key: { pk: 'SETTINGS' } }).resolves({
      Item: { automation: { whatsappAutomation: false } },
    });
    ddb.on(TransactWriteCommand).resolves({});

    const res = await api(
      apiEvent('POST /bookings', {
        body: JSON.stringify({ customerName: 'Ruwan', phone: '0775550001', date: todayISO(), time: '18:00', templateId: 'booking_confirmation' }),
      })
    );
    assert.equal((res as { statusCode: number }).statusCode, 201);
    assert.equal(ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!.length, 2);
    assert.equal(sqs.commandCalls(SendMessageCommand).length, 0);
  });

  it('returns 422 envelope for invalid input', async () => {
    const res = await api(apiEvent('POST /bookings', { body: JSON.stringify({ phone: 'x' }) }));
    const json = body(res);
    assert.equal((res as { statusCode: number }).statusCode, 422);
    assert.equal(json.success, false);
    assert.equal(json.code, 'VALIDATION_ERROR');
  });
});

describe('GET /bookings', () => {
  it('filters cancelled and searches by phone', async () => {
    const mk = (id: string, status: string, phone: string) => ({
      bookingId: id, customerId: 'c', customerName: 'Test', phone, date: '2026-11-10', time: '10:00',
      status, createdAt: '2026-11-01T00:00:00Z', entity: 'BOOKING', slot: `2026-11-10#10:00#${id}`,
    });
    ddb.on(QueryCommand).resolves({
      Items: [mk('MB-1', 'CANCELLED', '+94771111111'), mk('MB-2', 'CANCELLED', '+94772222222'), mk('MB-3', 'CONFIRMED', '+94771111111')],
    });
    const res = await api(apiEvent('GET /bookings', { queryStringParameters: { filter: 'cancelled', search: '077 111' } }));
    const json = body(res);
    assert.deepEqual(json.data.items.map((b: { bookingId: string }) => b.bookingId), ['MB-1']);
    assert.equal(json.data.total, 1);
    assert.equal(json.data.items[0].entity, undefined, 'storage attributes are stripped');
  });
});

describe('WhatsApp worker', () => {
  it('claims, sends, and marks SENT with the provider id', async () => {
    ddb.on(UpdateCommand).callsFake((input) => {
      if (String(input.UpdateExpression).includes('attempts')) {
        return {
          Attributes: {
            messageId: 'm1', bookingId: 'MB-1', customerName: 'Nimal', phone: '+94712335678',
            templateId: 'booking_confirmation', status: 'QUEUED', createdAt: 'x',
          },
        };
      }
      return {};
    });
    ddb.on(GetCommand, { Key: { bookingId: 'MB-1' } }).resolves({
      Item: { bookingId: 'MB-1', customerName: 'Nimal', date: '2026-11-10', time: '09:00' },
    });
    ddb.on(GetCommand, { Key: { pk: 'TEMPLATE#booking_confirmation' } }).resolves({ Item: DEFAULT_TEMPLATES[0] });

    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ messages: [{ id: 'wamid.ABC' }] }), { status: 200 })
    );

    const res = await worker({
      Records: [{ messageId: 'sqs-1', body: JSON.stringify({ messageId: 'm1' }), attributes: { ApproximateReceiveCount: '1' } }],
    } as unknown as SQSEvent);

    assert.deepEqual(res.batchItemFailures, []);
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.match(url, /graph\.facebook\.com\/v\d+\.\d+\/123\/messages$/);
    assert.equal(JSON.parse(String(init.body)).template.name, 'booking_confirmation');

    const sentUpdate = ddb.commandCalls(UpdateCommand).find((c) => c.args[0].input.ExpressionAttributeValues?.[':st'] === 'SENT');
    assert.equal(sentUpdate?.args[0].input.ExpressionAttributeValues?.[':pid'], 'wamid.ABC');
  });

  it('retries on 5xx before the last attempt', async () => {
    ddb.on(UpdateCommand).callsFake((input) =>
      String(input.UpdateExpression).includes('attempts')
        ? { Attributes: { messageId: 'm1', bookingId: 'MB-1', phone: '+94712335678', templateId: 'booking_confirmation', status: 'QUEUED' } }
        : {}
    );
    ddb.on(GetCommand, { Key: { bookingId: 'MB-1' } }).resolves({ Item: { bookingId: 'MB-1', customerName: 'N', date: '2026-11-10', time: '09:00' } });
    ddb.on(GetCommand, { Key: { pk: 'TEMPLATE#booking_confirmation' } }).resolves({ Item: DEFAULT_TEMPLATES[0] });
    mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }));

    const res = await worker({
      Records: [{ messageId: 'sqs-1', body: JSON.stringify({ messageId: 'm1' }), attributes: { ApproximateReceiveCount: '1' } }],
    } as unknown as SQSEvent);
    assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: 'sqs-1' }]);
  });
});

describe('WhatsApp webhook', () => {
  it('verifies the subscription handshake', async () => {
    const res = await webhook({
      requestContext: { http: { method: 'GET' } },
      queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify', 'hub.challenge': '42' },
      headers: {},
    } as unknown as APIGatewayProxyEventV2);
    assert.equal((res as { body: string }).body, '42');
  });

  it('rejects unsigned posts and applies signed status updates', async () => {
    const payload = JSON.stringify({
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.ABC', status: 'delivered', timestamp: '1794200000' }] } }] }],
    });
    const unsigned = await webhook({
      requestContext: { http: { method: 'POST' } }, headers: {}, body: payload,
    } as unknown as APIGatewayProxyEventV2);
    assert.equal((unsigned as { statusCode: number }).statusCode, 401);

    ddb.on(QueryCommand).resolves({ Items: [{ messageId: 'm1', bookingId: 'MB-1', status: 'SENT' }] });
    ddb.on(UpdateCommand).resolves({});
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(payload).digest('hex')}`;
    const res = await webhook({
      requestContext: { http: { method: 'POST' } }, headers: { 'x-hub-signature-256': sig }, body: payload,
    } as unknown as APIGatewayProxyEventV2);
    assert.equal((res as { statusCode: number }).statusCode, 200);

    const updates = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    assert.equal(updates[0].ExpressionAttributeValues?.[':st'], 'DELIVERED');
    assert.equal(updates[1].Key?.bookingId, 'MB-1'); // mirrored to the booking
  });
});

