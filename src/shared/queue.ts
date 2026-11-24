import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import { updateMessageStatus } from './db';
import type { SendMessageJob } from './types';

const sqs = new SQSClient({});

/**
 * Enqueue a WhatsApp send. If SQS rejects the job the message is marked FAILED
 * immediately so it shows up in the app and can be resent — it never sits
 * silently in QUEUED forever.
 */
export async function enqueueSend(messageId: string): Promise<boolean> {
  const job: SendMessageJob = { messageId };
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.SEND_QUEUE_URL,
        MessageBody: JSON.stringify(job),
      })
    );
    return true;
  } catch (error) {
    console.error('Failed to enqueue WhatsApp send', { messageId, error: (error as Error).name });
    await updateMessageStatus(messageId, 'FAILED', {
      failureReason: 'Could not queue the message. Please resend.',
    });
    return false;
  }
}
