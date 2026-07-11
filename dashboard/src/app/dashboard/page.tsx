import { sql } from '../lib/db';
import { cookies } from 'next/headers';
import React from 'react';
import { Activity, Globe, CheckCircle2, RefreshCw, Clock, Users, Download } from 'lucide-react';
import Link from 'next/link';
import { checkAdminToken } from '../lib/analytics';
import LoginForm from './LoginForm';
import Logout from './Logout';

export const dynamic = 'force-dynamic';

type LogRow = {
  id: number;
  event_type: string;
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
      sql<LogRow>`SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT 200;`,
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

        {/* Recent events */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-400" />
            <span className="font-semibold">Recent Events</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-800/50 text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="px-6 py-3 font-medium">Event</th>
                  <th className="px-6 py-3 font-medium">Step</th>
                  <th className="px-6 py-3 font-medium">Location</th>
                  <th className="px-6 py-3 font-medium">Retries</th>
                  <th className="px-6 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {logs.length === 0 && !dbError && (
                  <tr><td colSpan={5} className="px-6 py-8 text-center text-slate-500">No events yet.</td></tr>
                )}
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="px-6 py-3">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${badgeClass(log.event_type)}`}>
                        {log.event_type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-slate-400">{log.step || '—'}</td>
                    <td className="px-6 py-3 text-slate-400">
                      <span className="inline-flex items-center gap-1"><Globe className="w-3.5 h-3.5" />{[log.city, log.country].filter(Boolean).join(', ') || '—'}</span>
                    </td>
                    <td className="px-6 py-3 text-slate-400">{log.retries ?? '—'}</td>
                    <td className="px-6 py-3 text-slate-400">
                      <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{new Date(log.created_at).toLocaleString()}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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

