'use client';

import React, { useState } from 'react';

export default function LoginForm({ reason }: { reason?: string }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        setError('Incorrect token.');
      }
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-8 space-y-5"
      >
        <div>
          <h1 className="text-2xl font-bold">Owner Dashboard</h1>
          <p className="text-slate-400 text-sm mt-1">
            {reason || 'Enter your admin token to view analytics.'}
          </p>
        </div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ADMIN_TOKEN"
          className="w-full px-4 py-3 rounded-lg bg-slate-950 border border-slate-700 outline-none focus:border-emerald-500"
        />
        {error && <p className="text-rose-400 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 rounded-lg font-semibold transition-colors"
        >
          {loading ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
