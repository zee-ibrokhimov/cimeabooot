import { NextResponse } from 'next/server';
import { checkAdminToken } from '../../lib/analytics';

export const runtime = 'nodejs';

// POST /api/login  { token }  -> sets an httpOnly admin cookie if valid.
export async function POST(request: Request) {
  let body: { token?: string } = {};
  try { body = await request.json(); } catch { /* ignore */ }

  const token = (body.token || '').trim();
  if (!checkAdminToken(token)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set('cimea_admin', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 12, // 12h
  });
  return res;
}

// DELETE /api/login -> log out.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set('cimea_admin', '', { path: '/', maxAge: 0 });
  return res;
}
