import { sql } from '../lib/db';
import { cookies } from 'next/headers';
import React from 'react';
import { Activity, Globe, CheckCircle2, RefreshCw, Clock, Users, Download, ChevronDown, CreditCard } from 'lucide-react';
import Link from 'next/link';
import { checkAdminToken } from '../lib/analytics';
import LoginForm from './LoginForm';
import Logout from './Logout';

export const dynamic = 'force-dynamic';

type LogRow = {
  id: number;
  event_type: string;
  user_id: number | null;
  user_label: string | null;
  client_id: string | null;
  session_id: string | null;
  step: string | null;
  retries: number | null;
  duration_ms: number | null;
  error_type: string | null;
  country: string | null;
  city: string | null;
  created_at: string;
};

type UserGroup = {
  key: string;
  label: string;
  events: LogRow[];
  lastAt: string;
  location: string;
  reachedPay: boolean;
  success: boolean;
};

export default async function DashboardPage() {
  // ---- Auth gate ----------------------------------------------------------
  if (!process.env.ADMIN_TOKEN) {
    return <LoginForm reason="Set the ADMIN_TOKEN environment variable in Vercel to enable the dashboard." />;
  }
  const cookieStore = await cookies();
  const token = cookieStore.get('cimea_admin')?.value || null;
  if (!checkAdminToken(token)) {
    return <LoginForm />;
  }

  // ---- Data ---------------------------------------------------------------
  let logs: LogRow[] = [];
  let dbError: string | null = null;
  const counts: Record<string, number> = {};
  let uniqueUsers = 0;
  let totalRetries = 0;
  let topCountries: { country: string; n: number }[] = [];

  try {
    const [logsRes, countsRes, usersRes, retriesRes, countriesRes] = await Promise.all([
      sql<LogRow>`
        SELECT l.id, l.event_type, l.user_id, l.client_id, l.session_id, l.step,
               l.retries, l.duration_ms, l.error_type, l.country, l.city, l.created_at,
               COALESCE(u.telegram_username, u.email,
                        CASE WHEN l.user_id IS NOT NULL THEN 'user #' || l.user_id END,
                        'anonymous') AS user_label
        FROM usage_logs l LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.created_at DESC LIMIT 500;`,
      sql`SELECT event_type, COUNT(*)::int AS n FROM usage_logs GROUP BY event_type;`,
      sql`SELECT COUNT(DISTINCT client_id)::int AS n FROM usage_logs WHERE client_id IS NOT NULL;`,
      sql`SELECT COALESCE(SUM(retries),0)::int AS n FROM usage_logs WHERE event_type = 'save_next_clicked';`,
      sql`SELECT country, COUNT(DISTINCT client_id)::int AS n FROM usage_logs WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC LIMIT 8;`,
    ]);
    logs = logsRes.rows;
    for (const r of countsRes.rows) counts[r.event_type as string] = r.n as number;
    uniqueUsers = (usersRes.rows[0]?.n as number) || 0;
    totalRetries = (retriesRes.rows[0]?.n as number) || 0;
    topCountries = countriesRes.rows.map((r) => ({ country: r.country as string, n: r.n as number }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dbError = msg.includes('relation "usage_logs" does not exist')
      ? 'No data yet — the table is created automatically on the first tracked event.'
      : 'Could not reach Postgres. Is the database linked in Vercel?';
  }

  const installs = counts['extension_installed'] || 0;
  const started = counts['automation_started'] || 0;
  const reachedPay = counts['payment_page_reached'] || 0;
  const success = counts['payment_success'] || 0;
  const totalEvents = Object.values(counts).reduce((a, b) => a + b, 0);
  const successRate = started > 0 ? Math.round((success / started) * 100) : 0;

  // Group the recent-events feed by user so it isn't one long flat list. Logs
  // arrive newest-first, so the first row seen for a user is their latest.
  const groupsMap = new Map<string, UserGroup>();
  for (const log of logs) {
    const key = log.user_id != null ? `u${log.user_id}` : (log.client_id ? `c${log.client_id}` : 'anon');
    let g = groupsMap.get(key);
    if (!g) {
      g = {
        key, label: log.user_label || 'anonymous', events: [], lastAt: log.created_at,
        location: [log.city, log.country].filter(Boolean).join(', '), reachedPay: false, success: false,
      };
      groupsMap.set(key, g);
    }
    g.events.push(log);
    if (!g.location) g.location = [log.city, log.country].filter(Boolean).join(', ');
    if (log.event_type === 'payment_page_reached') g.reachedPay = true;
    if (log.event_type === 'payment_success') g.success = true;
  }
  const userGroups = Array.from(groupsMap.values()).sort(
    (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime(),
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans p-6 md:p-12">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Owner Dashboard</h1>
            <p className="text-slate-400 mt-1">Anonymous analytics · CIMEA Helper Pro</p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/dashboard/users" className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-colors">Users</Link>
            <Link href="/" className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-colors">Home</Link>
            <Logout />
          </div>
        </div>

        {dbError && (
          <div className="p-4 mb-8 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center gap-3">
            <span className="flex h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
            {dbError}
          </div>
        )}

        {/* Top stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6 mb-6">
          <StatCard icon={<Download className="text-blue-400" />} title="Installs" value={installs} />
          <StatCard icon={<Users className="text-cyan-400" />} title="Unique Users" value={uniqueUsers} />
          <StatCard icon={<CheckCircle2 className="text-emerald-400" />} title="Successful Payments" value={success} />
          <StatCard icon={<RefreshCw className="text-purple-400" />} title="Total Retries" value={totalRetries} />
        </div>

        {/* Funnel + countries */}
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          <Panel title="Conversion Funnel">
            <FunnelRow label="Automation started" value={started} max={Math.max(started, 1)} color="bg-blue-500" />
            <FunnelRow label="Reached payment page" value={reachedPay} max={Math.max(started, 1)} color="bg-cyan-500" />
            <FunnelRow label="Payment successful" value={success} max={Math.max(started, 1)} color="bg-emerald-500" />
            <p className="text-slate-400 text-sm mt-4">
              Success rate: <span className="text-emerald-400 font-semibold">{successRate}%</span> of started runs
              · {totalEvents} total events
            </p>
          </Panel>

          <Panel title="Top Countries (unique users)">
            {topCountries.length === 0 && <p className="text-slate-500 text-sm">No location data yet.</p>}
            <div className="space-y-3">
              {topCountries.map((c) => (
                <div key={c.country} className="flex items-center gap-3">
                  <span className="w-10 text-slate-300 font-mono text-sm">{c.country}</span>
                  <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500"
                         style={{ width: `${(c.n / Math.max(topCountries[0].n, 1)) * 100}%` }} />
                  </div>
                  <span className="text-slate-400 text-sm w-8 text-right">{c.n}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        {/* Activity grouped by user (collapsible) */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              <span className="font-semibold">Activity by user</span>
            </div>
            <span className="text-xs text-slate-500">
              {userGroups.length} {userGroups.length === 1 ? 'user' : 'users'} · {logs.length} recent events
            </span>
          </div>
          {userGroups.length === 0 && !dbError && (
            <div className="px-6 py-8 text-center text-slate-500">No events yet.</div>
          )}
          <div className="divide-y divide-slate-800/50">
            {userGroups.map((g) => (
              <details key={g.key} className="group">
                <summary className="px-6 py-4 flex items-center justify-between gap-3 cursor-pointer hover:bg-slate-800/30 list-none [&::-webkit-details-marker]:hidden">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-medium truncate">{g.label}</span>
                    {g.success
                      ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border bg-emerald-500/10 border-emerald-500/20 text-emerald-400"><CheckCircle2 className="w-3 h-3" /> paid</span>
                      : g.reachedPay
                        ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border bg-cyan-500/10 border-cyan-500/20 text-cyan-300"><CreditCard className="w-3 h-3" /> reached payment</span>
                        : null}
                    {g.location && <span className="hidden sm:inline-flex items-center gap-1 text-xs text-slate-500"><Globe className="w-3 h-3" />{g.location}</span>}
                  </div>
                  <div className="flex items-center gap-4 text-sm text-slate-400 shrink-0">
                    <span>{g.events.length} {g.events.length === 1 ? 'event' : 'events'}</span>
                    <span className="hidden sm:inline">{new Date(g.lastAt).toLocaleString()}</span>
                    <ChevronDown className="w-4 h-4 transition-transform group-open:rotate-180" />
                  </div>
                </summary>
                <div className="overflow-x-auto bg-slate-950/40 border-t border-slate-800/50">
                  <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="px-6 py-2 font-medium">Event</th>
                        <th className="px-6 py-2 font-medium">Step</th>
                        <th className="px-6 py-2 font-medium">Retries</th>
                        <th className="px-6 py-2 font-medium">Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/40">
                      {g.events.map((log) => (
                        <tr key={log.id} className="hover:bg-slate-800/20">
                          <td className="px-6 py-2">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${badgeClass(log.event_type)}`}>
                              {log.event_type.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-6 py-2 text-slate-400">{log.step || '—'}</td>
                          <td className="px-6 py-2 text-slate-400">{log.retries ?? '—'}</td>
                          <td className="px-6 py-2 text-slate-400">
                            <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{new Date(log.created_at).toLocaleTimeString()}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function badgeClass(event: string): string {
  if (event === 'payment_success') return 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
  if (event === 'error' || event === 'server_crash_detected' || event === 'daily_limit_hit')
    return 'bg-rose-500/10 border-rose-500/20 text-rose-400';
  if (event === 'extension_installed') return 'bg-blue-500/10 border-blue-500/20 text-blue-400';
  return 'bg-slate-500/10 border-slate-500/20 text-slate-300';
}

function StatCard({ icon, title, value }: { icon: React.ReactNode; title: string; value: number }) {
  return (
    <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex items-center gap-4">
      <div className="w-11 h-11 bg-slate-800 rounded-xl flex items-center justify-center border border-slate-700">{icon}</div>
      <div>
        <p className="text-slate-400 text-xs font-medium">{title}</p>
        <p className="text-2xl font-bold mt-0.5">{value}</p>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
      <h2 className="font-semibold mb-4">{title}</h2>
      {children}
    </div>
  );
}

function FunnelRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="mb-3">
      <div className="flex justify-between text-sm mb-1">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-400">{value}</span>
      </div>
      <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${(value / max) * 100}%` }} />
      </div>
    </div>
  );
}

