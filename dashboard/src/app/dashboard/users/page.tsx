import { sql } from '../../lib/db';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { checkAdminToken } from '../../lib/analytics';
import { ensureAuthTables } from '../../lib/auth';
import LoginForm from '../LoginForm';
import UsersManager, { AdminUser } from './UsersManager';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  if (!process.env.ADMIN_TOKEN) {
    return <LoginForm reason="Set the ADMIN_TOKEN environment variable in Vercel to enable the dashboard." />;
  }
  const store = await cookies();
  if (!checkAdminToken(store.get('cimea_admin')?.value || null)) {
    return <LoginForm />;
  }

  let users: AdminUser[] = [];
  let dbError: string | null = null;
  try {
    await ensureAuthTables();
    const { rows } = await sql`
      SELECT
        u.id, u.email, u.active, u.expires_at, u.created_at,
        MAX(CASE WHEN l.event_type = 'payment_page_reached' THEN l.created_at END) AS last_payment_page,
        COUNT(*) FILTER (WHERE l.event_type = 'payment_page_reached')::int AS payment_page_count,
        COUNT(*) FILTER (WHERE l.event_type = 'payment_success')::int      AS success_count,
        MAX(s.last_seen_at) AS last_seen
      FROM users u
      LEFT JOIN usage_logs l ON l.user_id = u.id
      LEFT JOIN sessions s   ON s.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `;
    users = rows as unknown as AdminUser[];
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
        <UsersManager initialUsers={users} />
      </div>
    </div>
  );
}
