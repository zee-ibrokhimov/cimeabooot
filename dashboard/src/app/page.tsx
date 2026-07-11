import React from 'react';
import Link from 'next/link';
import { Zap, RefreshCw, ShieldCheck, Bell, CreditCard, Volume2 } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#030712] text-slate-50 font-sans overflow-x-hidden">
      <div className="fixed top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-emerald-600/20 blur-[120px] pointer-events-none" />
      <div className="fixed bottom-[-20%] right-[-10%] w-[600px] h-[600px] rounded-full bg-cyan-600/10 blur-[150px] pointer-events-none" />

      <nav className="fixed w-full border-b border-slate-800/50 bg-[#030712]/70 backdrop-blur-xl z-50">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center font-bold text-slate-950">C</div>
            <span className="font-bold text-xl tracking-tight">CIMEA Helper Pro</span>
          </div>
          <Link href="/dashboard" className="text-sm font-semibold text-slate-300 hover:text-emerald-400 transition-colors">Owner Dashboard</Link>
        </div>
      </nav>

      <section className="relative pt-40 pb-24 max-w-4xl mx-auto px-6 text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-semibold mb-8">
          <ShieldCheck className="w-4 h-4" /> Card data stays 100% on your device
        </div>
        <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight mb-6 leading-[1.1]">
          Automate the <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400">CIMEA portal</span>
        </h1>
        <p className="text-lg text-slate-400 max-w-2xl mx-auto mb-10">
          Auto-navigation, auto-retry on server errors, and payment alerts. Only anonymous usage
          statistics are shared — never your card, CVC, or Telegram token.
        </p>
        <a href="/cimea-helper-pro.zip"
           className="inline-flex items-center gap-2 px-8 py-4 bg-emerald-500 hover:bg-emerald-600 text-white rounded-full font-bold transition-transform hover:scale-105">
          Download Extension
        </a>
        <p className="text-slate-500 text-sm mt-4">Load unpacked in <code className="text-slate-300">chrome://extensions</code> (Developer mode).</p>
      </section>

      <section className="py-20 border-t border-slate-800/50 bg-slate-900/20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid md:grid-cols-3 gap-6">
            <Feature icon={<Zap className="text-emerald-400" />} title="Auto Navigation" desc="Clicks 'Save and next' and drives the request flow automatically." />
            <Feature icon={<RefreshCw className="text-rose-400" />} title="Crash Recovery" desc="Detects 502/503/504 errors and retries until the portal responds." />
            <Feature icon={<CreditCard className="text-blue-400" />} title="Local Card Autofill" desc="Optionally fills the payment form — stored only in your browser." />
            <Feature icon={<Bell className="text-yellow-400" />} title="Telegram Alerts" desc="Pings your own bot the moment payment succeeds." />
            <Feature icon={<Volume2 className="text-orange-400" />} title="Payment Alarm" desc="Beeps when you reach the Nexi gateway so you don't miss it." />
            <Feature icon={<ShieldCheck className="text-cyan-400" />} title="Private by Design" desc="Analytics is opt-in, anonymous, and sent only to your own endpoint." />
          </div>
        </div>
      </section>

      <footer className="py-10 text-center border-t border-slate-800/80 text-slate-500 text-sm">
        CIMEA Helper Pro · your data, your endpoint
      </footer>
    </div>
  );
}

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800 p-7 rounded-3xl hover:-translate-y-1 transition-transform">
      <div className="w-14 h-14 bg-slate-950 rounded-2xl flex items-center justify-center mb-6 border border-slate-800">{icon}</div>
      <h3 className="text-xl font-bold mb-2">{title}</h3>
      <p className="text-slate-400 leading-relaxed">{desc}</p>
    </div>
  );
}
