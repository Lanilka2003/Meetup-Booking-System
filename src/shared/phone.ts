const CLEAN = /[\s\-().]/g;

/**
 * Normalise a Sri Lankan mobile number to E.164 (+947XXXXXXXX).
 * Same rules as `frontend/src/utils/phone.ts` — the server never trusts the client.
 */
export function toE164(raw: string): string | null {
  let s = String(raw ?? '').replace(CLEAN, '').trim();
  if (!s) return null;

  if (s.startsWith('+')) {
    if (!s.startsWith('+94')) return null;
    s = s.slice(3);
  } else if (s.startsWith('94')) {
    s = s.slice(2);
  }

  if (s.length === 10 && s.startsWith('0')) s = s.slice(1);
  if (!/^[0-9]+$/.test(s)) return null;
  if (s.length !== 9 || !s.startsWith('7')) return null;

  return `+94${s}`;
}

/** Stable customer id derived from the phone number, so one phone = one customer. */
export function customerIdFor(e164: string): string {
  return `cust-${e164.replace(/\D/g, '')}`;
}

/** WhatsApp Cloud API expects the number without the leading "+". */
export function toWhatsAppRecipient(e164: string): string {
  return e164.replace(/\D/g, '');
}
