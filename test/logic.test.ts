import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { HttpError, paginate } from '../src/shared/http';
import { customerIdFor, toE164 } from '../src/shared/phone';
import { canTransition, fromWhatsAppStatus } from '../src/shared/status';
import { DEFAULT_TEMPLATES, renderTemplate, templateVariables, variablesIn } from '../src/shared/templates';
import { addDays, formatTime12h, isValidISODate, todayISO } from '../src/shared/time';
import { validateCreateBooking, validateUpdateSettings } from '../src/shared/validation';
import { buildTemplatePayload } from '../src/shared/whatsapp';
import { isValidSignature } from '../src/handlers/webhook';

describe('phone', () => {
  it('normalises Sri Lankan mobiles to E.164', () => {
    for (const raw of ['0771234567', '077 123 4567', '+94 77 123 4567', '94771234567', '771234567']) {
      assert.equal(toE164(raw), '+94771234567', raw);
    }
  });
  it('rejects invalid numbers', () => {
    for (const raw of ['', '0112345678', '+4477123456', '07712345', 'abc']) {
      assert.equal(toE164(raw), null, raw);
    }
  });
  it('derives a stable customer id', () => {
    assert.equal(customerIdFor('+94771234567'), 'cust-94771234567');
  });
});

describe('time', () => {
  it('computes today in Asia/Colombo, not UTC', () => {
    // 20:00 UTC = 01:30 next day in Colombo (+05:30)
    assert.equal(todayISO(new Date('2026-11-09T20:00:00Z'), 'Asia/Colombo'), '2026-11-10');
  });
  it('adds days across month ends', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });
  it('validates calendar dates', () => {
    assert.ok(isValidISODate('2028-02-29'));
    assert.ok(!isValidISODate('2026-02-30'));
  });
  it('formats 12h time', () => {
    assert.equal(formatTime12h('00:05'), '12:05 AM');
    assert.equal(formatTime12h('14:30'), '2:30 PM');
  });
});

describe('validateCreateBooking', () => {
  const today = '2026-11-09';
  const valid = { customerName: '  Shalini   Perera ', phone: '077 123 4567', date: '2026-11-10', time: '15:30', templateId: 'booking_confirmation' };

  it('normalises a valid booking', () => {
    assert.deepEqual(validateCreateBooking(valid, today), {
      customerName: 'Shalini Perera',
      phone: '+94771234567',
      date: '2026-11-10',
      time: '15:30',
      templateId: 'booking_confirmation',
      notes: undefined,
    });
  });

  it('returns field errors with 422', () => {
    try {
      validateCreateBooking({ ...valid, phone: '123', date: '2026-11-01', time: '25:00' }, today);
      assert.fail('expected error');
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 422);
      const details = error.details as Record<string, string>;
      assert.ok(details.phone && details.date && details.time);
    }
  });
});

describe('validateUpdateSettings', () => {
  it('accepts known boolean toggles', () => {
    assert.deepEqual(validateUpdateSettings({ automation: { bookingReminder: false } }), {
      automation: { bookingReminder: false },
      notifications: undefined,
    });
  });
  it('rejects unknown keys and non-booleans', () => {
    assert.throws(() => validateUpdateSettings({ automation: { hack: true } }), HttpError);
    assert.throws(() => validateUpdateSettings({ notifications: { pushNotifications: 'yes' } }), HttpError);
    assert.throws(() => validateUpdateSettings({}), HttpError);
  });
});

describe('templates', () => {
  const confirmation = DEFAULT_TEMPLATES[0];
  const vars = templateVariables({ customerName: 'Nimal', date: '2026-11-10', time: '09:00', bookingId: 'MB-ABC123' });

  it('lists variables in order', () => {
    assert.deepEqual(variablesIn(confirmation.body), ['customer_name', 'date', 'time', 'booking_id']);
  });
  it('renders a body', () => {
    const text = renderTemplate(confirmation.body, vars);
    assert.match(text, /Hello Nimal, .* Tuesday, 10 November 2026 at 9:00 AM\. Booking ID: MB-ABC123/);
  });
  it('builds a named-parameter Cloud API payload', () => {
    const payload = buildTemplatePayload(confirmation, '+94771234567', vars, 'named') as {
      to: string;
      template: { name: string; components: { parameters: { parameter_name: string; text: string }[] }[] };
    };
    assert.equal(payload.to, '94771234567');
    assert.equal(payload.template.name, 'booking_confirmation');
    assert.deepEqual(payload.template.components[0].parameters[0], {
      type: 'text',
      parameter_name: 'customer_name',
      text: 'Nimal',
    });
  });
});

describe('message status transitions', () => {
  it('only moves forward', () => {
    assert.ok(canTransition('QUEUED', 'SENT'));
    assert.ok(canTransition('SENT', 'READ'));
    assert.ok(!canTransition('READ', 'DELIVERED'));
    assert.ok(!canTransition('DELIVERED', 'FAILED'));
    assert.ok(canTransition('SENT', 'FAILED'));
  });
  it('requeues only on manual resend', () => {
    assert.ok(!canTransition('FAILED', 'QUEUED'));
    assert.ok(canTransition('FAILED', 'QUEUED', true));
  });
  it('maps webhook statuses', () => {
    assert.equal(fromWhatsAppStatus('delivered'), 'DELIVERED');
    assert.equal(fromWhatsAppStatus('deleted'), undefined);
  });
});

describe('pagination', () => {
  it('pages with an opaque token', () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const p1 = paginate(items, 20);
    assert.equal(p1.items.length, 20);
    assert.equal(p1.total, 45);
    const p3 = paginate(items, 20, paginate(items, 20, p1.nextToken).nextToken);
    assert.deepEqual(p3.items, [40, 41, 42, 43, 44]);
    assert.equal(p3.nextToken, undefined);
  });
  it('rejects tampered tokens', () => {
    assert.throws(() => paginate([1], 20, 'garbage!'), HttpError);
  });
});

describe('webhook signature', () => {
  it('accepts a valid HMAC and rejects others', () => {
    const body = '{"entry":[]}';
    const sig = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
    assert.ok(isValidSignature(body, sig, 'secret'));
    assert.ok(!isValidSignature(body, sig, 'other'));
    assert.ok(!isValidSignature(body, undefined, 'secret'));
  });
});
