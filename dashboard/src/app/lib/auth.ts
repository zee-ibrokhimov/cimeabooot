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

// ---- password hashing -------------------------------------------------------
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  try {
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
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
      id          SERIAL PRIMARY KEY,
      email       VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      password_salt VARCHAR(64)  NOT NULL,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      expires_at  TIMESTAMP WITH TIME ZONE,
      created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
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
  ensured = true;
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
  } catch { return false; }
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
