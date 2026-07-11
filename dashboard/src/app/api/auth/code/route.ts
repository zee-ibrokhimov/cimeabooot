import { NextResponse } from 'next/server';
import {
  authenticateByCode, createSession, hashCode,
  isLockedOut, recordFailedLogin, clearFailedLogins,
} from '../../../lib/auth';
import { clientIp } from '../../../lib/net';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/code  { code, clientId }  -> { token }  (device-bound)
export async function POST(request: Request) {
  const raw = await request.text().catch(() => '');
  if (raw.length > 4096) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }
  let body: { code?: string; clientId?: string } = {};
  try { body = JSON.parse(raw); } catch { /* ignore */ }

  const code = String(body.code || '').trim();
  const clientId = String(body.clientId || '').slice(0, 64);
  if (!code || !clientId || code.length > 64) {
    return NextResponse.json({ ok: false, error: 'missing code' }, { status: 400 });
  }

  const ip = clientIp(request.headers);
  // Rate-limit on the code (hashed, so we don't log the code) and the IP.
  const codeKey = 'code:' + hashCode(code).slice(0, 24);
  const ipKey = 'ip:' + ip;

  try {
    if (await isLockedOut(codeKey) || await isLockedOut(ipKey)) {
      return NextResponse.json({ ok: false, error: 'too many attempts, try later' }, { status: 429 });
    }

    const result = await authenticateByCode(code, clientId);
    if ('error' in result) {
      // Only count guessing (invalid) against the brute-force limiter; a valid
      // code used on the wrong device ("bound") is not a guess.
      if (result.error === 'invalid') {
        await recordFailedLogin(codeKey);
        await recordFailedLogin(ipKey);
      }
      const status = result.error === 'bound' ? 409 : 401;
      return NextResponse.json({ ok: false, error: result.error }, { status });
    }

    await clearFailedLogins(codeKey);
    await clearFailedLogins(ipKey);
    const token = await createSession(result.userId, request.headers.get('user-agent'));
    return NextResponse.json({ ok: true, token }, { status: 200 });
  } catch (e) {
    console.error('code login error:', e);
    return NextResponse.json({ ok: false, error: 'server error' }, { status: 500 });
  }
}
