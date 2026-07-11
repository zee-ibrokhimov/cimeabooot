'use client';

import React, { useState } from 'react';
import { UserPlus, CheckCircle2, XCircle, Trash2, CreditCard } from 'lucide-react';

export interface AdminUser {
  id: number;
  email: string;
  active: boolean;
  expires_at: string | null;
  created_at: string;
  last_payment_page: string | null;
  payment_page_count: number;
  success_count: number;
  last_seen: string | null;
}

export default function UsersManager({ initialUsers }: { initialUsers: AdminUser[] }) {
  const [users, setUsers] = useState<AdminUser[]>(initialUsers);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const res = await fetch('/api/admin/users', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users || []);
    }
  }

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setEmail(''); setPassword(''); setMsg('✓ User created.');
        await refresh();
      } else {
        setMsg('⚠ ' + (data.error || 'Failed to create user.'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(u: AdminUser) {
    await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id: u.id, active: !u.active }),
    });
    await refresh();
  }

  async function resetPassword(u: AdminUser) {
    const pw = window.prompt(`New password for ${u.email} (min 6 chars):`);
    if (!pw) return;
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id: u.id, password: pw }),
    });
    setMsg(res.ok ? '✓ Password reset (user signed out everywhere).' : '⚠ Reset failed.');
  }

  async function removeUser(u: AdminUser) {
    if (!window.confirm(`Delete ${u.email}? This cannot be undone.`)) return;
    await fetch(`/api/admin/users?id=${u.id}`, { method: 'DELETE', credentials: 'include' });
    await refresh();
  }

  return (
    <div className="space-y-6">
      {/* Create user */}
      <form onSubmit={addUser} className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2"><UserPlus className="w-4 h-4 text-emerald-400" /> Create user</h2>
        <div className="flex flex-col md:flex-row gap-3">
          <input
            type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="user@email.com"
            className="flex-1 px-4 py-2.5 rounded-lg bg-slate-950 border border-slate-700 outline-none focus:border-emerald-500"
          />
          <input
            type="text" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="temporary password (min 10)"
            className="flex-1 px-4 py-2.5 rounded-lg bg-slate-950 border border-slate-700 outline-none focus:border-emerald-500"
          />
          <button type="submit" disabled={busy}
            className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 rounded-lg font-semibold transition-colors">
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
        {msg && <p className="text-sm mt-3 text-slate-300">{msg}</p>}
      </form>

      {/* Users table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-800/50 text-slate-400 border-b border-slate-800">
              <tr>
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Reached payment page</th>
                <th className="px-5 py-3 font-medium">Successes</th>
                <th className="px-5 py-3 font-medium">Last seen</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {users.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-500">No users yet. Create one above.</td></tr>
              )}
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-800/30">
                  <td className="px-5 py-3 font-medium">{u.email}</td>
                  <td className="px-5 py-3">
                    {u.active ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 className="w-4 h-4" /> active</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-rose-400"><XCircle className="w-4 h-4" /> disabled</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {u.last_payment_page ? (
                      <span className="inline-flex items-center gap-1 text-cyan-300">
                        <CreditCard className="w-4 h-4" />
                        {new Date(u.last_payment_page).toLocaleString()}
                        <span className="text-slate-500">(×{u.payment_page_count})</span>
                      </span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-300">{u.success_count || 0}</td>
                  <td className="px-5 py-3 text-slate-400">{u.last_seen ? new Date(u.last_seen).toLocaleString() : '—'}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={() => toggleActive(u)} className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-xs">
                        {u.active ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => resetPassword(u)} className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-xs">
                        Reset pw
                      </button>
                      <button onClick={() => removeUser(u)} className="p-1.5 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-400" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
