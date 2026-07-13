import { sql } from '../../lib/db';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { checkAdminToken } from '../../lib/analytics';
import { ensureAuthTables } from '../../lib/auth';
import LoginForm from '../LoginForm';
import UsersManager, { AdminUser } from './UsersManager';

export const dynamic = 'force-dynamic';

type PendingReq = { telegram_id: number; username: string | null; reason: string | null; created_at: string };

export default async function UsersPage() {
  if (!process.env.ADMIN_TOKEN) {
    return <LoginForm reason="Set the ADMIN_TOKEN environment variable in Vercel to enable the dashboard." />;
  }
  const store = await cookies();
  if (!checkAdminToken(store.get('cimea_admin')?.value || null)) {
    return <LoginForm />;
  }

  let users: AdminUser[] = [];
  let pending: PendingReq[] = [];
  let dbError: string | null = null;
  try {
    await ensureAuthTables();
    const { rows } = await sql`
      SELECT
        u.id, u.email, u.telegram_username, (u.bound_client_id IS NOT NULL) AS device_bound,
        u.active, u.expires_at, u.created_at,
        ul.last_payment_page, ul.payment_page_count, ul.success_count,
        ul.distinct_ips_7d, ul.distinct_countries_7d,
        s.last_seen, ar.reason AS request_reason
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
      LEFT JOIN access_requests ar ON ar.telegram_id = u.telegram_id
      ORDER BY u.created_at DESC
    `;
    users = rows as unknown as AdminUser[];

    // People who asked for access but aren't approved users yet (the vetting queue).
    const pend = await sql`
      SELECT ar.telegram_id, ar.username, ar.reason, ar.created_at
      FROM access_requests ar
      LEFT JOIN users u ON u.telegram_id = ar.telegram_id
      WHERE u.id IS NULL
      ORDER BY ar.created_at DESC
      LIMIT 100
    `;
    pending = pend.rows as unknown as PendingReq[];
  } catch (e) {
    dbError = e instanceof Error ? e.message : 'Could not load users.';
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans p-6 md:p-12">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Users</h1>
            <p className="text-slate-400 mt-1">Create accounts and see who reached the payment page.</p>
          </div>
          <Link href="/dashboard" className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-colors">
            ← Analytics
          </Link>
        </div>
        {dbError && (
          <div className="p-4 mb-6 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400">{dbError}</div>
        )}

        {/* Pending access requests — the vetting queue (approve/deny in the bot) */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
            <span className="font-semibold">🕓 Pending access requests</span>
            <span className="text-xs text-slate-500">{pending.length} awaiting review · approve/deny in the Telegram bot</span>
          </div>
          {pending.length === 0 ? (
            <div className="px-6 py-8 text-center text-slate-500">No pending requests.</div>
          ) : (
            <ul className="divide-y divide-slate-800/50">
              {pending.map((p) => (
                <li key={p.telegram_id} className="px-6 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">
                      {p.username ? '@' + p.username : 'user'}{' '}
                      <span className="text-slate-500 font-mono text-xs">#{p.telegram_id}</span>
                    </span>
                    <span className="text-xs text-slate-500">{new Date(p.created_at).toLocaleString()}</span>
                  </div>
                  {p.reason && <p className="text-sm text-slate-400 mt-1 whitespace-pre-wrap break-words">“{p.reason}”</p>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <UsersManager initialUsers={users} />
      </div>
    </div>
  );
}
