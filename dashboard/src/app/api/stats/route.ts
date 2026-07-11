import { sql } from '../../lib/db';
import { NextResponse } from 'next/server';
import { checkAdminToken } from '../../lib/analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/stats  -> aggregate metrics only (admin only).
// Requires Authorization: Bearer <ADMIN_TOKEN>. Token is never read from the URL.
export async function GET(request: Request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;

  if (!checkAdminToken(token)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const [counts, users, retries] = await Promise.all([
      sql`SELECT event_type, COUNT(*)::int AS n FROM usage_logs GROUP BY event_type;`,
      sql`SELECT COUNT(DISTINCT client_id)::int AS n FROM usage_logs WHERE client_id IS NOT NULL;`,
      sql`SELECT COALESCE(SUM(retries),0)::int AS n FROM usage_logs WHERE event_type = 'save_next_clicked';`,
    ]);

    const byEvent: Record<string, number> = {};
    for (const r of counts.rows) byEvent[r.event_type as string] = r.n as number;

    const started = byEvent['automation_started'] || 0;
    const success = byEvent['payment_success'] || 0;

    return NextResponse.json({
      success: true,
      stats: {
        byEvent,
        uniqueUsers: (users.rows[0]?.n as number) || 0,
        totalRetries: (retries.rows[0]?.n as number) || 0,
        successRatePct: started > 0 ? Math.round((success / started) * 100) : 0,
      },
    });
  } catch {
    return NextResponse.json({ success: true, stats: { byEvent: {}, uniqueUsers: 0, totalRetries: 0, successRatePct: 0 } });
  }
}
