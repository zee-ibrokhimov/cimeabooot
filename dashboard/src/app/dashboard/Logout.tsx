'use client';

import React from 'react';

export default function Logout() {
  async function logout() {
    try {
      await fetch('/api/login', { method: 'DELETE' });
    } finally {
      window.location.reload();
    }
  }
  return (
    <button
      onClick={logout}
      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-colors"
    >
      Log out
    </button>
  );
}
