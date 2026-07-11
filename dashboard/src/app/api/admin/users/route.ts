import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { sql } from '../../../lib/db';
import { checkAdminToken } from '../../../lib/analytics';
import { createUser, hashPassword, ensureAuthTables, resetDeviceBinding } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Owner gate: accepts the httpOnly admin cookie (dashboard UI) or a Bearer token.
async function isOwner(request: Request): Promise<boolean> {
  const store = await cookies();
  const cookieTok = store.get('cimea_admin')?.value || null;
  if (checkAdminToken(cookieTok)) return true;
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;
  return checkAdminToken(bearer);
}

// GET /api/admin/users -> list users with activity (reached payment page, successes)
export async function GET(request: Request) {
  if (!(await isOwner(request))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    await ensureAuthTables();
    const { rows } = await sql`
      SELECT
        u.id, u.email, u.telegram_username, (u.bound_client_id IS NOT NULL) AS device_bound,
        u.active, u.expires_at, u.created_at,
        ul.last_payment_page, ul.payment_page_count, ul.success_count,
        ul.distinct_ips_7d, ul.distinct_countries_7d,
        s.last_seen
      FROM users u
      LEFT JOIN (
        SELECT user_id,
          MAX(CASE WHEN event_type = 'payment_page_reached' THEN created_at END) AS last_payment_page,
          COUNT(*) FILTER (WHERE event_type = 'payment_page_reached')::int AS payment_page_count,
          COUNT(*) FILTER (WHERE event_type = 'payment_success')::int      AS success_count,
          COUNT(DISTINCT ip_hash) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS distinct_ips_7d,
          COUNT(DISTINCT country) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS distinct_countries_7d
        FROM usage_logs GROUP BY user_id
      ) ul ON ul.user_id = u.id
      LEFT JOIN (
        SELECT user_id, MAX(last_seen_at) AS last_seen FROM sessions GROUP BY user_id
      ) s ON s.user_id = u.id
      ORDER BY u.created_at DESC
    `;
    return NextResponse.json({ ok: true, users: rows }, { status: 200 });
  } catch (e) {
    console.error('list users error:', e);
    return NextResponse.json({ ok: false, error: 'query failed' }, { status: 500 });
  }
}

// POST /api/admin/users  { email, password }  -> create a user
export async function POST(request: Request) {
  if (!(await isOwner(request))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  let body: { email?: string; password?: string } = {};
  try { body = await request.json(); } catch { /* ignore */ }
  const result = await createUser(String(body.email || ''), String(body.password || ''));
  if ('error' in result) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
}

// PATCH /api/admin/users  { id, active?, password?, resetDevice? }
export async function PATCH(request: Request) {
  if (!(await isOwner(request))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  let body: { id?: number; active?: boolean; password?: string; resetDevice?: boolean } = {};
  try { body = await request.json(); } catch { /* ignore */ }
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ ok: false, error: 'invalid id' }, { status: 400 });
  }
  try {
    await ensureAuthTables();
    if (body.resetDevice) {
      // Clear the device binding so the code can be activated on a new device.
      await resetDeviceBinding(id);
    }
    if (typeof body.active === 'boolean') {
      await sql`UPDATE users SET active = ${body.active} WHERE id = ${id}`;
      // Disabling a user also revokes their existing sessions.
      if (body.active === false) await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    }
    if (body.password) {
      if (body.password.length < 10) {
        return NextResponse.json({ ok: false, error: 'password too short (min 10)' }, { status: 400 });
      }
      const { salt, hash } = hashPassword(body.password);
      await sql`UPDATE users SET password_hash = ${hash}, password_salt = ${salt} WHERE id = ${id}`;
      // Force re-login everywhere after a password reset.
      await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    console.error('patch user error:', e);
    return NextResponse.json({ ok: false, error: 'update failed' }, { status: 500 });
  }
}

// DELETE /api/admin/users?id=123  -> delete a user (and their sessions via cascade)
export async function DELETE(request: Request) {
  if (!(await isOwner(request))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const raw = new URL(request.url).searchParams.get('id');
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: 'invalid id' }, { status: 400 });
  }
  try {
    await sql`DELETE FROM users WHERE id = ${id}`;
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    console.error('delete user error:', e);
    return NextResponse.json({ ok: false, error: 'delete failed' }, { status: 500 });
  }
}
