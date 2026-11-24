/**
 * Domain types. These mirror `frontend/src/types/*` — the API response shapes
 * must stay identical so the app can consume them without changes.
 */

export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'RESCHEDULED';
export type MessageStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
export type MessageKind = 'confirmation' | 'reminder' | 'resend';

export interface Booking {
  bookingId: string;
  customerId: string;
  customerName: string;
  phone: string;
  date: string;
  time: string;
  status: BookingStatus;
  templateId?: string;
  notes?: string;
  createdAt: string;
  updatedAt?: string;
  createdBy?: string;
  whatsappStatus?: MessageStatus;
  messageId?: string;
  reminderSentAt?: string;
}

/** Booking as returned by GET /bookings/{id} — enriched with the latest message. */
export interface BookingDetails extends Booking {
  providerMessageId?: string;
  queuedAt?: string;
  sentAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  failureReason?: string;
}

export interface Message {
  messageId: string;
  bookingId: string;
  customerName: string;
  phone: string;
  templateId: string;
  kind?: MessageKind;
  status: MessageStatus;
  providerMessageId?: string;
  queuedAt?: string;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
  failedAt?: string;
  failureReason?: string;
  createdAt: string;
  attempts?: number;
}

export interface Customer {
  customerId: string;
  name: string;
  phone: string;
  createdAt: string;
  updatedAt?: string;
  bookingCount?: number;
}

export interface MessageTemplate {
  templateId: string;
  name: string;
  description?: string;
  body: string;
  active: boolean;
  category?: string;
  /** Language code of the approved WhatsApp template, e.g. "en". */
  language?: string;
}

export interface AutomationSettings {
  whatsappAutomation: boolean;
  bookingConfirmation: boolean;
  bookingReminder: boolean;
}

export interface NotificationSettings {
  pushNotifications: boolean;
  messageDeliveryNotifications: boolean;
}

export interface StoredSettings {
  companyName: string;
  whatsappBusinessNumber: string;
  automation: AutomationSettings;
  notifications: NotificationSettings;
}

export interface CompanySettings {
  account: { name: string; email: string; role: string };
  company: { companyName: string; whatsappBusinessNumber: string; whatsappConnected: boolean };
  automation: AutomationSettings;
  notifications: NotificationSettings;
  security: { mfaEnabled: boolean; mfaConfigured: boolean };
}

export interface Paginated<T> {
  items: T[];
  nextToken?: string;
  total?: number;
}

/** Body of an SQS job consumed by the WhatsApp worker. */
export interface SendMessageJob {
  messageId: string;
}
