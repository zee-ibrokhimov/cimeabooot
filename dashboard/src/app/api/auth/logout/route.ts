import { NextResponse } from 'next/server';
import { deleteSession, bearer } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/logout   Authorization: Bearer <token>  -> revokes this session
export async function POST(request: Request) {
  await deleteSession(bearer(request));
  return NextResponse.json({ ok: true }, { status: 200 });
}
