// =============================================================================
// User authentication for the gated extension.
//
// - Owner-provisioned accounts (no public signup).
// - Passwords stored as scrypt hashes (never plaintext).
// - Opaque session tokens; only their SHA-256 hash is stored, so a DB leak
//   does not expose usable tokens. Multiple concurrent sessions per user are
//   allowed (multi-device).
// =============================================================================
import crypto from 'crypto';
import { sql } from './db';

const SCRYPT_KEYLEN = 64;
// Stronger scrypt cost than the Node default (N=16384); maxmem is raised to fit.
// hash and verify MUST use identical options.
const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

// ---- password hashing -------------------------------------------------------
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  try {
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
    const expected = Buffer.from(hash, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---- session tokens ---------------------------------------------------------
export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---- schema -----------------------------------------------------------------
let ensured = false;
export async function ensureAuthTables() {
  if (ensured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         VARCHAR(255) UNIQUE,
      password_hash VARCHAR(255),
      password_salt VARCHAR(64),
      telegram_id       BIGINT,
      telegram_username VARCHAR(64),
      code_hash         VARCHAR(64),
      bound_client_id   VARCHAR(64),
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      expires_at  TIMESTAMP WITH TIME ZONE,
      created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  // Migrate older DBs to the Telegram-code model (idempotent).
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(64);`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS code_hash VARCHAR(64);`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS bound_client_id VARCHAR(64);`;
  await sql`ALTER TABLE users ALTER COLUMN email DROP NOT NULL;`;
  await sql`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;`;
  await sql`ALTER TABLE users ALTER COLUMN password_salt DROP NOT NULL;`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_key ON users(telegram_id);`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_code_hash_key ON users(code_hash);`;
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  VARCHAR(64) PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_agent  VARCHAR(255),
      created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      expires_at  TIMESTAMP WITH TIME ZONE
    );
  `;
  await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;`;
  // Persistent, cross-instance brute-force counter for login.
  await sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      key          VARCHAR(320) PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  // The owner dashboard / user list joins usage_logs; make sure it exists even
  // before the first tracked event on a fresh database.
  await sql`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      event_type  VARCHAR(64) NOT NULL,
      user_id     INTEGER,
      client_id   VARCHAR(64),
      session_id  VARCHAR(64),
      ext_version VARCHAR(20),
      step        VARCHAR(40),
      retries     INTEGER,
      duration_ms INTEGER,
      error_type  VARCHAR(40),
      country     VARCHAR(64),
      city        VARCHAR(128),
      ip_hash     VARCHAR(32),
      created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  // Access requests: the reason a person gave when asking for access, so the
  // owner can vet genuine need. Kept separate from users (a request exists
  // before approval). The dashboard joins this by telegram_id.
  await sql`
    CREATE TABLE IF NOT EXISTS access_requests (
      telegram_id  BIGINT PRIMARY KEY,
      username     VARCHAR(64),
      reason       TEXT,
      created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  ensured = true;
}

/** Store (or update) the reason a Telegram user gave when requesting access. */
export async function recordAccessRequest(
  telegramId: number,
  username: string | null,
  reason: string,
): Promise<void> {
  try {
    await ensureAuthTables();
    await sql`
      INSERT INTO access_requests (telegram_id, username, reason, created_at)
      VALUES (${telegramId}, ${(username || '').slice(0, 64) || null}, ${reason.slice(0, 1000)}, CURRENT_TIMESTAMP)
      ON CONFLICT (telegram_id) DO UPDATE SET
        username = EXCLUDED.username, reason = EXCLUDED.reason, created_at = CURRENT_TIMESTAMP
    `;
  } catch (e) {
    console.error('recordAccessRequest error:', e);
  }
}

/** True if this Telegram user already has active access (so the bot shouldn't
 *  treat their message as a new request). */
export async function isActiveTelegramUser(telegramId: number): Promise<boolean> {
  try {
    await ensureAuthTables();
    const { rows } = await sql`SELECT 1 FROM users WHERE telegram_id = ${telegramId} AND active = TRUE LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Remove a pending access request (e.g. after Deny) so it drops off the queue. */
export async function clearAccessRequest(telegramId: number): Promise<void> {
  try { await sql`DELETE FROM access_requests WHERE telegram_id = ${telegramId}`; } catch { /* ignore */ }
}

// Session lifetime bounds.
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;      // 7 days since last use
// Login lockout policy.
const LOGIN_MAX = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// ---- login brute-force counter (DB-backed, shared across instances) ---------
export async function isLockedOut(key: string): Promise<boolean> {
  try {
    await ensureAuthTables();
    const { rows } = await sql`SELECT count, window_start FROM login_attempts WHERE key = ${key} LIMIT 1`;
    const r = rows[0];
    if (!r) return false;
    const fresh = Date.now() - new Date(r.window_start as string).getTime() < LOGIN_WINDOW_MS;
    return fresh && (r.count as number) >= LOGIN_MAX;
  } catch (e) {
    // Fail open (don't lock everyone out on a DB blip) but make it visible.
    console.warn('login limiter unavailable (fail-open):', e instanceof Error ? e.message : e);
    return false;
  }
}
export async function recordFailedLogin(key: string): Promise<void> {
  try {
    await sql`
      INSERT INTO login_attempts (key, count, window_start)
      VALUES (${key}, 1, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN CURRENT_TIMESTAMP - login_attempts.window_start > ${LOGIN_WINDOW_MS + ' milliseconds'}::interval
          THEN 1 ELSE login_attempts.count + 1 END,
        window_start = CASE
          WHEN CURRENT_TIMESTAMP - login_attempts.window_start > ${LOGIN_WINDOW_MS + ' milliseconds'}::interval
          THEN CURRENT_TIMESTAMP ELSE login_attempts.window_start END
    `;
  } catch { /* ignore */ }
}
export async function clearFailedLogins(key: string): Promise<void> {
  try { await sql`DELETE FROM login_attempts WHERE key = ${key}`; } catch { /* ignore */ }
}

export interface SessionUser {
  userId: number;
  email: string;
}

// ---- user management (owner) ------------------------------------------------
export async function createUser(email: string, password: string): Promise<{ id: number } | { error: string }> {
  const normEmail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail)) return { error: 'invalid email' };
  if (!password || password.length < 10) return { error: 'password too short (min 10)' };
  await ensureAuthTables();
  const { salt, hash } = hashPassword(password);
  try {
    const { rows } = await sql`
      INSERT INTO users (email, password_hash, password_salt)
      VALUES (${normEmail}, ${hash}, ${salt})
      RETURNING id
    `;
    return { id: rows[0].id as number };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('duplicate key')) return { error: 'email already exists' };
    return { error: 'could not create user' };
  }
}

// ---- login / verify ---------------------------------------------------------
export async function authenticate(email: string, password: string): Promise<SessionUser | null> {
  await ensureAuthTables();
  const normEmail = (email || '').trim().toLowerCase();
  const { rows } = await sql`
    SELECT id, email, password_hash, password_salt, active, expires_at
    FROM users WHERE email = ${normEmail} LIMIT 1
  `;
  const u = rows[0];
  if (!u) {
    // Waste time similar to a real hash to blunt user-enumeration timing.
    hashPassword(password);
    return null;
  }
  if (!verifyPassword(password, u.password_salt as string, u.password_hash as string)) return null;
  if (u.active === false) return null;
  if (u.expires_at && new Date(u.expires_at as string).getTime() < Date.now()) return null;
  return { userId: u.id as number, email: u.email as string };
}

export async function createSession(userId: number, userAgent: string | null): Promise<string> {
  await ensureAuthTables();
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_MS).toISOString();
  await sql`
    INSERT INTO sessions (token_hash, user_id, user_agent, expires_at)
    VALUES (${hashToken(token)}, ${userId}, ${(userAgent || '').slice(0, 255)}, ${expiresAt})
  `;
  // Opportunistic cleanup of expired/idle sessions.
  try {
    await sql`DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP
              OR last_seen_at < ${new Date(Date.now() - SESSION_IDLE_MS).toISOString()}`;
  } catch { /* ignore */ }
  return token;
}

/** Returns the session's user if the token is valid AND the account is still
 *  active / unexpired; otherwise null. Updates last_seen_at. */
export async function verifySession(token: string | null): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    await ensureAuthTables();
    const th = hashToken(token);
    const { rows } = await sql`
      SELECT s.token_hash, s.expires_at AS session_expires, s.last_seen_at,
             u.id AS user_id, u.email, u.active, u.expires_at AS user_expires
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${th} LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    if (r.active === false) return null;
    const now = Date.now();
    // Account-level expiry.
    if (r.user_expires && new Date(r.user_expires as string).getTime() < now) return null;
    // Session absolute expiry.
    if (r.session_expires && new Date(r.session_expires as string).getTime() < now) {
      await sql`DELETE FROM sessions WHERE token_hash = ${th}`;
      return null;
    }
    // Idle timeout since last use.
    if (r.last_seen_at && (now - new Date(r.last_seen_at as string).getTime()) > SESSION_IDLE_MS) {
      await sql`DELETE FROM sessions WHERE token_hash = ${th}`;
      return null;
    }
    await sql`UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ${th}`;
    return { userId: r.user_id as number, email: r.email as string };
  } catch {
    return null;
  }
}

export async function deleteSession(token: string | null): Promise<void> {
  if (!token) return;
  try {
    await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
  } catch { /* ignore */ }
}

export function bearer(request: Request): string | null {
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;
}

// =============================================================================
// Telegram access-code login (device-bound). Provisioning happens via the bot:
// the owner approves a user, which mints a random code stored only as a hash.
// The extension exchanges the code (+ its device id) for a rotating session.
// =============================================================================

// Human-friendly base32 code, e.g. "K7QW-9F3M-2XTP" (~60 bits).
const B32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity
export function newCode(): string {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += B32[bytes[i] % B32.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}
function normCode(code: string): string {
  return (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(normCode(code)).digest('hex');
}

/** Owner approved a Telegram user -> upsert the user and mint a FRESH code
 *  (invalidating any prior code + device binding). Returns the plaintext code. */
export async function approveTelegramUser(
  telegramId: number,
  username: string | null
): Promise<{ code: string } | { error: string }> {
  await ensureAuthTables();
  const code = newCode();
  const ch = hashCode(code);
  try {
    await sql`
      INSERT INTO users (telegram_id, telegram_username, code_hash, bound_client_id, active)
      VALUES (${telegramId}, ${(username || '').slice(0, 64) || null}, ${ch}, NULL, TRUE)
      ON CONFLICT (telegram_id) DO UPDATE SET
        telegram_username = EXCLUDED.telegram_username,
        code_hash = EXCLUDED.code_hash,
        bound_client_id = NULL,
        active = TRUE
    `;
    return { code };
  } catch (e) {
    console.error('approveTelegramUser error:', e);
    return { error: 'could not create user' };
  }
}

/** Repeat request from an ALREADY-APPROVED, active user: mint a FRESH code
 *  (OTP-style) WITHOUT another owner approval, and DON'T touch bound_client_id —
 *  so the new code stays locked to the same device they already activated on
 *  (or binds on first use if they never activated). Returns the new plaintext
 *  code, or null if the user isn't eligible (unknown / disabled / consumed),
 *  in which case the caller falls back to the owner-approval flow. */
export async function regenerateCodeForUser(telegramId: number): Promise<string | null> {
  try {
    await ensureAuthTables();
    const { rows } = await sql`
      SELECT id FROM users WHERE telegram_id = ${telegramId} AND active = TRUE LIMIT 1
    `;
    const u = rows[0];
    if (!u) return null; // not approved / disabled / consumed -> owner approval
    const code = newCode();
    await sql`UPDATE users SET code_hash = ${hashCode(code)} WHERE id = ${u.id}`;
    return code;
  } catch (e) {
    console.error('regenerateCodeForUser error:', e);
    return null;
  }
}

/** Exchange an access code (+ device id) for a session identity. Enforces the
 *  device binding: first use binds the code to that clientId; later uses from a
 *  different device are rejected until the owner resets the binding. */
export async function authenticateByCode(
  code: string,
  clientId: string
): Promise<SessionUser | { error: 'invalid' | 'inactive' | 'expired' | 'bound' | 'no_device' }> {
  await ensureAuthTables();
  if (!clientId) return { error: 'no_device' };
  const ch = hashCode(code);
  const { rows } = await sql`
    SELECT id, email, active, expires_at, bound_client_id
    FROM users WHERE code_hash = ${ch} LIMIT 1
  `;
  const u = rows[0];
  if (!u) return { error: 'invalid' };
  if (u.active === false) return { error: 'inactive' };
  if (u.expires_at && new Date(u.expires_at as string).getTime() < Date.now()) return { error: 'expired' };

  const bound = u.bound_client_id as string | null;
  if (!bound) {
    await sql`UPDATE users SET bound_client_id = ${clientId} WHERE id = ${u.id}`;
  } else if (bound !== clientId) {
    return { error: 'bound' };
  }
  return { userId: u.id as number, email: (u.email as string) || `tg:${u.id}` };
}

/** Owner action: clear the device binding so the user can activate on a new
 *  device (or hand the code to someone else). */
export async function resetDeviceBinding(userId: number): Promise<void> {
  try {
    await sql`UPDATE users SET bound_client_id = NULL WHERE id = ${userId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  } catch { /* ignore */ }
}
