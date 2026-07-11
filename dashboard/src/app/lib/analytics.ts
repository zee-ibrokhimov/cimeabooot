// =============================================================================
// Shared analytics contract + helpers for the tracking API and dashboard.
//
// The server independently enforces the same allowlist the extension uses:
// only fixed fields are stored, and each is validated to a strict format
// (ids, semver, lowercase labels) so a modified/hostile client cannot add extra
// fields. Free-text PII is strongly constrained by these format checks, but
// treat all ingested analytics as untrusted for any decision that matters.
// =============================================================================
import crypto from 'crypto';

export const ALLOWED_EVENTS = [
  'extension_installed',
  'automation_started',
  'automation_stopped',
  'payment_page_reached',
  'save_next_clicked',
  'daily_limit_hit',
  'server_crash_detected',
  'payment_success',
  'error',
] as const;

export type AllowedEvent = (typeof ALLOWED_EVENTS)[number];

export interface CleanEvent {
  event: AllowedEvent;
  clientId: string | null;
  sessionId: string | null;
  extVersion: string | null;
  step: string | null;
  retries: number | null;
  durationMs: number | null;
  errorType: string | null;
}

// Any of these appearing in a key or string value means the request is hostile
// or misconfigured; we reject the whole thing.
const SENSITIVE = /card|cvc|cvv|\bpan\b|expir|holder|token|chat|secret|password|passwd|\bpin\b/i;

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (SENSITIVE.test(s)) return null;
  if (/\d{12,}/.test(s.replace(/[\s-]/g, ''))) return null; // looks like a card number
  return s.slice(0, max);
}

// Positive-format validators: accept ONLY the shape we expect, so free-text
// PII (emails, names, phone numbers) can't be smuggled into an allowlisted
// field by a modified client.
function token(v: unknown, re: RegExp, max: number): string | null {
  const s = str(v, max);
  return s && re.test(s) ? s : null;
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;      // client/session ids (uuid or c_/s_...)
const VER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;  // semver
const LABEL_RE = /^[a-z0-9_]{1,40}$/;        // coarse step / errorType labels

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Clamp to a sane range so a client can't push absurd values.
  return Math.max(0, Math.min(v, 1e9));
}

/**
 * Validate + normalise an incoming payload into a strict CleanEvent, or return
 * null if it is invalid / contains anything sensitive.
 */
export function sanitizeEvent(raw: unknown): CleanEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // Reject outright if any KEY looks sensitive (defense in depth).
  for (const key of Object.keys(obj)) {
    if (SENSITIVE.test(key)) return null;
  }

  const event = obj.event;
  if (typeof event !== 'string' || !ALLOWED_EVENTS.includes(event as AllowedEvent)) {
    return null;
  }

  return {
    event: event as AllowedEvent,
    clientId: token(obj.clientId, ID_RE, 64),
    sessionId: token(obj.sessionId, ID_RE, 64),
    extVersion: token(obj.extVersion, VER_RE, 20),
    step: token(obj.step, LABEL_RE, 40),
    retries: num(obj.retries),
    durationMs: num(obj.durationMs),
    errorType: token(obj.errorType, LABEL_RE, 40),
  };
}

/**
 * One-way hash of the caller IP so we can count uniques without storing the raw
 * IP. Fails closed: returns null unless a dedicated, non-empty salt is given, so
 * we never hash with a guessable default that would make the value reversible.
 */
export function hashIp(ip: string | null, salt: string | undefined): string | null {
  if (!ip || !salt) return null;
  return crypto.createHash('sha256').update(salt + ':' + ip).digest('hex').slice(0, 24);
}

/** Constant-time compare for the admin token gate. Both sides are hashed to a
 *  fixed 32 bytes first, so there is no length-dependent early return (no length
 *  side-channel) and timingSafeEqual can never throw on a length mismatch. */
export function checkAdminToken(provided: string | null): boolean {
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected || !provided) return false; // no token configured -> stays locked
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
