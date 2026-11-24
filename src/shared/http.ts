import type { APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Response envelope expected by `frontend/src/lib/api.ts`:
 *   success → { success: true, data }
 *   failure → { success: false, message, code }
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = httpCode(status),
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function httpCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'VALIDATION_ERROR';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

export function ok<T>(data: T, status = 200): APIGatewayProxyResultV2 {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ success: true, data }) };
}

export function fail(error: unknown): APIGatewayProxyResultV2 {
  if (error instanceof HttpError) {
    return {
      statusCode: error.status,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        success: false,
        message: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      }),
    };
  }
  // Never leak internals to the client; full error goes to CloudWatch.
  console.error('Unhandled error', error);
  return {
    statusCode: 500,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      success: false,
      message: 'The server encountered an error. Please try again.',
      code: 'INTERNAL_ERROR',
    }),
  };
}

export function parseJsonBody(body: string | undefined, isBase64Encoded?: boolean): unknown {
  if (!body) return {};
  const raw = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

/**
 * Offset-based pagination over an already filtered + sorted list. The token is
 * opaque to the client (base64url JSON) so it can be swapped for DynamoDB keys later.
 */
export function paginate<T>(items: T[], limit: number, nextToken?: string): {
  items: T[];
  nextToken?: string;
  total: number;
} {
  const offset = decodeToken(nextToken);
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    items: page,
    nextToken: next < items.length ? encodeToken(next) : undefined,
    total: items.length,
  };
}

function encodeToken(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeToken(token?: string): number {
  if (!token) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { o?: unknown };
    const o = Number(parsed.o);
    if (Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Invalid pagination token.', 'INVALID_TOKEN');
}
