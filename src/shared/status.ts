import type { MessageStatus } from './types';

/** Forward order of WhatsApp delivery. READ must never go back to SENT. */
export const STATUS_RANK: Record<Exclude<MessageStatus, 'FAILED'>, number> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
};

/**
 * Statuses a message may move *from* to reach `next`.
 *
 * - Forward moves only along QUEUED → SENT → DELIVERED → READ (webhooks arrive out of order).
 * - FAILED can follow QUEUED or SENT, but never DELIVERED/READ.
 * - SENT/DELIVERED/READ may follow FAILED: Meta can confirm a message we gave up on after a timeout.
 * - QUEUED is only reachable from FAILED/QUEUED via a manual resend (`allowRequeue`).
 */
export function allowedPreviousStatuses(next: MessageStatus, allowRequeue = false): MessageStatus[] {
  if (next === 'QUEUED') return allowRequeue ? ['FAILED', 'QUEUED'] : [];
  if (next === 'FAILED') return ['QUEUED', 'SENT'];
  const rank = STATUS_RANK[next];
  const earlier = (Object.keys(STATUS_RANK) as (keyof typeof STATUS_RANK)[]).filter(
    (s) => STATUS_RANK[s] < rank
  );
  return [...earlier, 'FAILED'];
}

export function canTransition(from: MessageStatus, to: MessageStatus, allowRequeue = false): boolean {
  return allowedPreviousStatuses(to, allowRequeue).includes(from);
}

/** Map a WhatsApp Cloud API webhook status string to ours. */
export function fromWhatsAppStatus(status: string): MessageStatus | undefined {
  switch (status) {
    case 'sent':
      return 'SENT';
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'failed':
      return 'FAILED';
    default:
      return undefined;
  }
}
