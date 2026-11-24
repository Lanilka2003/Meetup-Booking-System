import { getStoredSettings, putStoredSettings } from './db';
import type { StoredSettings } from './types';
import type { UpdateSettingsInput } from './validation';

export const DEFAULT_SETTINGS: StoredSettings = {
  companyName: process.env.COMPANY_NAME || 'Mahaguru Meet Up',
  whatsappBusinessNumber: process.env.WHATSAPP_BUSINESS_NUMBER || '',
  automation: {
    whatsappAutomation: true,
    bookingConfirmation: true,
    bookingReminder: true,
  },
  notifications: {
    pushNotifications: true,
    messageDeliveryNotifications: true,
  },
};

/** Stored settings merged over defaults, so new toggles get a sane value. */
export async function loadSettings(): Promise<StoredSettings> {
  const stored = await getStoredSettings();
  return mergeSettings(DEFAULT_SETTINGS, stored ?? {});
}

export function mergeSettings(
  base: StoredSettings,
  patch: Partial<StoredSettings> | UpdateSettingsInput
): StoredSettings {
  const p = patch as Partial<StoredSettings>;
  return {
    companyName: p.companyName ?? base.companyName,
    whatsappBusinessNumber: p.whatsappBusinessNumber ?? base.whatsappBusinessNumber,
    automation: { ...base.automation, ...(p.automation ?? {}) },
    notifications: { ...base.notifications, ...(p.notifications ?? {}) },
  };
}

export async function updateSettings(input: UpdateSettingsInput): Promise<StoredSettings> {
  const next = mergeSettings(await loadSettings(), input);
  await putStoredSettings(next);
  return next;
}
