'use client';

import React, { useState } from 'react';
import { CheckCircle2, XCircle, Trash2, CreditCard, AlertTriangle, Smartphone, Send } from 'lucide-react';

export interface AdminUser {
  id: number;
  email: string | null;
  telegram_username: string | null;
  device_bound: boolean;
  active: boolean;
  expires_at: string | null;
  created_at: string;
  last_payment_page: string | null;
  payment_page_count: number;
  success_count: number;
  distinct_ips_7d: number;
  distinct_countries_7d: number;
  last_seen: string | null;
}

// Account-sharing signal: more than this many distinct IPs (or >1 country) in a
// week is suspicious for a single, device-bound account.
const SHARE_IP_THRESHOLD = 3;

function label(u: AdminUser): string {
  if (u.telegram_username) return '@' + u.telegram_username;
  if (u.email) return u.email;
  return 'user #' + u.id;
}

export default function UsersManager({ initialUsers }: { initialUsers: AdminUser[] }) {
  const [users, setUsers] = useState<AdminUser[]>(initialUsers);
  const [msg, setMsg] = useState('');

  async function refresh() {
    const res = await fetch('/api/admin/users', { credentials: 'include' });
    if (res.ok) setUsers((await res.json()).users || []);
  }

  async function patch(id: number, body: Record<string, unknown>, note: string) {
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id, ...body }),
    });
    setMsg(res.ok ? note : '⚠ Action failed.');
    await refresh();
  }

  async function removeUser(u: AdminUser) {
    if (!window.confirm(`Delete ${label(u)}? This cannot be undone.`)) return;
    await fetch(`/api/admin/users?id=${u.id}`, { method: 'DELETE', credentials: 'include' });
    await refresh();
  }

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <h2 className="font-semibold mb-2 flex items-center gap-2"><Send className="w-4 h-4 text-cyan-400" /> Provisioning</h2>
        <p className="text-slate-400 text-sm">
          Users are approved through the <b>Telegram bot</b>: they tap <i>Start</i>, you get an Approve/Deny prompt, and the bot
          sends them a one-time access code. Each code is <b>device-bound</b> — if someone switches devices, use <b>Reset device</b> below.
        </p>
        {msg && <p className="text-sm mt-3 text-slate-300">{msg}</p>}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-800/50 text-slate-400 border-b border-slate-800">
              <tr>
                <th className="px-5 py-3 font-medium">User</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Device</th>
                <th className="px-5 py-3 font-medium">Reached payment</th>
                <th className="px-5 py-3 font-medium">Successes</th>
                <th className="px-5 py-3 font-medium">Sharing (7d)</th>
                <th className="px-5 py-3 font-medium">Last seen</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {users.length === 0 && (
                <tr><td colSpan={8} className="px-5 py-8 text-center text-slate-500">No users yet — approve someone in the Telegram bot.</td></tr>
              )}
              {users.map((u) => {
                const ips = u.distinct_ips_7d || 0;
                const countries = u.distinct_countries_7d || 0;
                const suspicious = ips > SHARE_IP_THRESHOLD || countries > 1;
                return (
                  <tr key={u.id} className="hover:bg-slate-800/30">
                    <td className="px-5 py-3 font-medium">{label(u)}</td>
                    <td className="px-5 py-3">
                      {u.active
                        ? <span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 className="w-4 h-4" /> active</span>
                        : <span className="inline-flex items-center gap-1 text-rose-400"><XCircle className="w-4 h-4" /> disabled</span>}
                    </td>
                    <td className="px-5 py-3">
                      {u.device_bound
                        ? <span className="inline-flex items-center gap-1 text-slate-300"><Smartphone className="w-4 h-4" /> bound</span>
                        : <span className="text-slate-500">not activated</span>}
                    </td>
                    <td className="px-5 py-3">
                      {u.last_payment_page
                        ? <span className="inline-flex items-center gap-1 text-cyan-300"><CreditCard className="w-4 h-4" />{new Date(u.last_payment_page).toLocaleString()} <span className="text-slate-500">(×{u.payment_page_count})</span></span>
                        : <span className="text-slate-500">—</span>}
                    </td>
                    <td className="px-5 py-3 text-slate-300">{u.success_count || 0}</td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-flex items-center gap-1 ${suspicious ? 'text-rose-400 font-semibold' : 'text-slate-400'}`}
                        title={`${ips} distinct IPs, ${countries} countries in the last 7 days`}
                      >
                        {suspicious && <AlertTriangle className="w-4 h-4" />}
                        {ips} IP{ips === 1 ? '' : 's'}{countries > 1 ? ` · ${countries} countries` : ''}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-400">{u.last_seen ? new Date(u.last_seen).toLocaleString() : '—'}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        <button onClick={() => patch(u.id, { active: !u.active }, u.active ? '✓ Disabled.' : '✓ Enabled.')}
                          className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-xs">
                          {u.active ? 'Disable' : 'Enable'}
                        </button>
                        <button onClick={() => patch(u.id, { resetDevice: true }, '✓ Device reset — user can activate on a new device.')}
                          disabled={!u.device_bound}
                          className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs">
                          Reset device
                        </button>
                        <button onClick={() => removeUser(u)} title="Delete"
                          className="p-1.5 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-400">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
