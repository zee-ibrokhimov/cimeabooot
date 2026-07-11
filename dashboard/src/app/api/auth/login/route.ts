import { NextResponse } from 'next/server';
import {
  authenticate, createSession,
  isLockedOut, recordFailedLogin, clearFailedLogins,
} from '../../../lib/auth';
import { clientIp } from '../../../lib/net';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/login  { email, password }  -> { token, email }
export async function POST(request: Request) {
  // Cap the body so a huge password can't be fed straight into scrypt.
  const raw = await request.text().catch(() => '');
  if (raw.length > 4096) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }
  let body: { email?: string; password?: string } = {};
  try { body = JSON.parse(raw); } catch { /* ignore */ }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password || password.length > 1024) {
    return NextResponse.json({ ok: false, error: 'missing credentials' }, { status: 400 });
  }

  const ip = clientIp(request.headers);
  const emailKey = 'em:' + email;
  const ipKey = 'ip:' + ip;

  try {
    if (await isLockedOut(emailKey) || await isLockedOut(ipKey)) {
      return NextResponse.json({ ok: false, error: 'too many attempts, try later' }, { status: 429 });
    }

    const user = await authenticate(email, password);
    if (!user) {
      await recordFailedLogin(emailKey);
      await recordFailedLogin(ipKey);
      return NextResponse.json({ ok: false, error: 'invalid email or password' }, { status: 401 });
    }

    await clearFailedLogins(emailKey);
    await clearFailedLogins(ipKey);
    const token = await createSession(user.userId, request.headers.get('user-agent'));
    return NextResponse.json({ ok: true, token, email: user.email }, { status: 200 });
  } catch (e) {
    console.error('login error:', e);
    return NextResponse.json({ ok: false, error: 'server error' }, { status: 500 });
  }
}
