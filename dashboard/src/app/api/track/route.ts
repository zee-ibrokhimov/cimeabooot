import { sql } from '../../lib/db';
import { NextResponse } from 'next/server';
import { sanitizeEvent, hashIp, checkAdminToken } from '../../lib/analytics';
import { verifySession, bearer } from '../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ensure the table exists at most once per warm instance, not on every request.
let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
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
  // For databases created before per-user auth was added.
  await sql`ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS user_id INTEGER;`;
  tableEnsured = true;
}

// Best-effort in-memory rate limit (per warm instance). Not a hard guarantee on
// serverless, but curbs casual floods from a single source.
const RATE_MAX = 60; // requests
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.resetAt) {
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_MAX;
}

function clientIp(h: Headers): string | null {
  return h.get('x-forwarded-for')?.split(',')[0].trim() || h.get('x-real-ip') || null;
}

// -----------------------------------------------------------------------------
// POST /api/track  — receive one event from a logged-in user's extension.
// Requires a valid session token (Authorization: Bearer <token>); the event is
// attributed to that user. Unauthenticated events are rejected, which both
// gates ingestion and lets the owner see per-user activity (e.g. who reached
// the payment page).
// -----------------------------------------------------------------------------
export async function POST(request: Request) {
  try {
    const h = request.headers;

    const ip = clientIp(h);
    if (rateLimited(ip || 'unknown')) {
      return NextResponse.json({ success: false, error: 'rate limited' }, { status: 429 });
    }

    // Must be a logged-in, active user.
    const sessionUser = await verifySession(bearer(request));
    if (!sessionUser) {
      return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
    }

    const text = await request.text();
    if (text.length > 4096) {
      return NextResponse.json({ success: false, error: 'payload too large' }, { status: 413 });
    }

    let raw: unknown;
    try { raw = JSON.parse(text); } catch {
      return NextResponse.json({ success: false, error: 'invalid json' }, { status: 400 });
    }

    const clean = sanitizeEvent(raw);
    if (!clean) {
      return NextResponse.json({ success: false, error: 'rejected' }, { status: 422 });
    }

    // Geo + IP come from the edge/request, never from the client body.
    // Vercel sets x-vercel-ip-*; Cloudflare (tunnel) sets cf-ipcountry. On a
    // plain self-hosted proxy without GeoIP these are simply null.
    const country = h.get('x-vercel-ip-country') || h.get('cf-ipcountry') || null;
    const city = decodeURIComponent(h.get('x-vercel-ip-city') || '') || null;
    const ipHash = hashIp(ip, process.env.IP_SALT); // null unless IP_SALT is set

    await ensureTable();
    await sql`
      INSERT INTO usage_logs
        (event_type, user_id, client_id, session_id, ext_version, step, retries, duration_ms, error_type, country, city, ip_hash)
      VALUES
        (${clean.event}, ${sessionUser.userId}, ${clean.clientId}, ${clean.sessionId}, ${clean.extVersion},
         ${clean.step}, ${clean.retries}, ${clean.durationMs}, ${clean.errorType},
         ${country}, ${city}, ${ipHash})
    `;

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('track POST error:', error);
    return NextResponse.json({ success: false, error: 'server error' }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// GET /api/track  — recent logs (admin only). Requires
// Authorization: Bearer <ADMIN_TOKEN>. The token is never accepted in the URL.
// -----------------------------------------------------------------------------
export async function GET(request: Request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;

  if (!checkAdminToken(token)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await sql`SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT 200;`;
    return NextResponse.json({ success: true, logs: rows }, { status: 200 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('relation "usage_logs" does not exist')) {
      return NextResponse.json({ success: true, logs: [] }, { status: 200 });
    }
    return NextResponse.json({ success: false, error: 'query failed' }, { status: 500 });
  }
}
