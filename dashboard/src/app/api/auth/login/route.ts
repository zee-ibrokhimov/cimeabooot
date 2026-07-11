import { NextResponse } from 'next/server';
import {
  authenticate, createSession,
  isLockedOut, recordFailedLogin, clearFailedLogins,
} from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Trusted client IP: Vercel appends the real client IP as x-real-ip and as the
// RIGHTMOST x-forwarded-for entry. We avoid the leftmost XFF value, which the
// client can spoof.
function clientIp(h: Headers): string {
  const real = h.get('x-real-ip');
  if (real) return real.trim();
  const xff = h.get('x-forwarded-for');
  if (xff) { const parts = xff.split(','); return parts[parts.length - 1].trim(); }
  return 'unknown';
}

// POST /api/auth/login  { email, password }  -> { token, email }
export async function POST(request: Request) {
  let body: { email?: string; password?: string } = {};
  try { body = await request.json(); } catch { /* ignore */ }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) {
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
    const token = await createSession(user.userId, request.headers.get('user-agent'));
    return NextResponse.json({ ok: true, token, email: user.email }, { status: 200 });
  } catch (e) {
    console.error('login error:', e);
    return NextResponse.json({ ok: false, error: 'server error' }, { status: 500 });
  }
}
