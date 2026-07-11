import { NextResponse } from 'next/server';
import { verifySession, bearer } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/verify   Authorization: Bearer <token>
// The extension calls this to confirm the session is still valid/active.
export async function POST(request: Request) {
  const user = await verifySession(bearer(request));
  if (!user) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true, email: user.email }, { status: 200 });
}
