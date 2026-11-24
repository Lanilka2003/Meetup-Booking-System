import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { toWhatsAppRecipient } from './phone';
import { variablesIn } from './templates';
import type { MessageTemplate } from './types';

/**
 * WhatsApp Cloud API client. Credentials live ONLY in AWS Secrets Manager
 * (secret ARN injected as WHATSAPP_SECRET_ARN). Secret JSON shape:
 *
 *   {
 *     "accessToken":   "EAAG...",        // permanent System User token
 *     "phoneNumberId": "1234567890",     // WhatsApp Business phone number id
 *     "appSecret":     "abc123...",      // Meta app secret (webhook signature check)
 *     "verifyToken":   "any-random-string" // must match the webhook config in Meta
 *   }
 */

export interface WhatsAppSecret {
  accessToken?: string;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
}

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v23.0';
const PARAMETER_FORMAT = (process.env.WHATSAPP_PARAMETER_FORMAT || 'named') as 'named' | 'positional';
export const DRY_RUN = process.env.WHATSAPP_DRY_RUN === 'true';

const secrets = new SecretsManagerClient({});
let cached: { value: WhatsAppSecret; at: number } | undefined;
const CACHE_MS = 5 * 60_000;

export async function getWhatsAppSecret(): Promise<WhatsAppSecret> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const arn = process.env.WHATSAPP_SECRET_ARN;
  let value: WhatsAppSecret = {};
  if (arn) {
    try {
      const out = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
      value = JSON.parse(out.SecretString || '{}') as WhatsAppSecret;
    } catch (error) {
      console.error('Could not read WhatsApp secret', (error as Error).name);
    }
  }
  cached = { value, at: Date.now() };
  return value;
}

export function isSendConfigured(secret: WhatsAppSecret): boolean {
  return Boolean(secret.accessToken && secret.phoneNumberId);
}

export async function whatsappConnected(): Promise<boolean> {
  return DRY_RUN || isSendConfigured(await getWhatsAppSecret());
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

/** Build the Cloud API request body for a template message. */
export function buildTemplatePayload(
  template: MessageTemplate,
  toE164: string,
  vars: Record<string, string>,
  format: 'named' | 'positional' = PARAMETER_FORMAT
): Record<string, unknown> {
  const names = variablesIn(template.body);
  const parameters = names.map((name) =>
    format === 'named'
      ? { type: 'text', parameter_name: name, text: vars[name] ?? '' }
      : { type: 'text', text: vars[name] ?? '' }
  );
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWhatsAppRecipient(toE164),
    type: 'template',
    template: {
      name: template.templateId,
      language: { code: template.language || 'en' },
      ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
    },
  };
}

/** Send a template message. Returns the provider message id ("wamid..."). */
export async function sendTemplateMessage(
  template: MessageTemplate,
  toE164: string,
  vars: Record<string, string>
): Promise<string> {
  if (DRY_RUN) {
    console.log(JSON.stringify({ msg: 'WhatsApp dry-run send', templateId: template.templateId }));
    return `dryrun.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  }

  const secret = await getWhatsAppSecret();
  if (!isSendConfigured(secret)) {
    throw new WhatsAppError(
      'WhatsApp is not configured. Add accessToken and phoneNumberId to the WhatsApp secret.',
      false
    );
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${secret.phoneNumberId}/messages`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTemplatePayload(template, toE164, vars)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new WhatsAppError(`Network error calling WhatsApp: ${(error as Error).message}`, true);
  }

  const body = (await response.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { message?: string; code?: number; error_data?: { details?: string } };
  };

  if (!response.ok) {
    const detail = body.error?.error_data?.details || body.error?.message || `HTTP ${response.status}`;
    const retryable = response.status === 429 || response.status >= 500;
    throw new WhatsAppError(`WhatsApp API error (${body.error?.code ?? response.status}): ${detail}`, retryable, response.status);
  }

  const id = body.messages?.[0]?.id;
  if (!id) throw new WhatsAppError('WhatsApp API returned no message id.', true);
  return id;
}
