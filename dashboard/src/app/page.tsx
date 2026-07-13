import React from 'react';
import Link from 'next/link';
import { Zap, RefreshCw, ShieldCheck, Bell, CreditCard, Volume2, Send, MessageCircle, ChevronDown } from 'lucide-react';

// Where users request access (your Telegram bot). Change if you rename the bot.
const TELEGRAM_BOT_URL = 'https://t.me/cimearadarbot';
// The owner's public Telegram for direct questions.
const OWNER_CONTACT_URL = 'https://t.me/uniway_admin';

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
          <div className="flex items-center gap-5">
            <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-slate-300 hover:text-emerald-400 transition-colors">Get Access</a>
            <Link href="/dashboard" className="text-sm font-semibold text-slate-300 hover:text-emerald-400 transition-colors">Owner Dashboard</Link>
          </div>
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
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-2 px-8 py-4 bg-emerald-500 hover:bg-emerald-600 text-white rounded-full font-bold transition-transform hover:scale-105">
            <Send className="w-4 h-4" /> Request Access on Telegram
          </a>
          <a href="/cimea-helper-pro.zip"
             className="inline-flex items-center gap-2 px-8 py-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white rounded-full font-bold transition-transform hover:scale-105">
            Download Extension
          </a>
        </div>
        <p className="text-slate-500 text-sm mt-6 max-w-2xl mx-auto">
          New here? Tap <b className="text-slate-300">Request Access</b> — the owner approves you and the bot sends your code.
          Then load the extension unpacked in <code className="text-slate-300">chrome://extensions</code> (Developer mode) and paste your code.
        </p>
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

      {/* How it works */}
      <section className="py-24 border-t border-slate-800/50 max-w-5xl mx-auto px-6">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">How it works</h2>
        <p className="text-slate-400 text-center mb-14 max-w-xl mx-auto">Free, but access is granted individually — reviewed by the owner.</p>
        <div className="grid md:grid-cols-3 gap-6">
          <Step n={1} title="Request access" desc="Message the Telegram bot and tell us why you need it — your situation or deadline." />
          <Step n={2} title="Get approved" desc="The owner reviews your request and the bot sends you a one-time access code." />
          <Step n={3} title="Install & run" desc="Load the extension, paste your code, and it drives the CIMEA flow to the payment page." />
        </div>
        <div className="text-center mt-12">
          <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-2 px-8 py-4 bg-emerald-500 hover:bg-emerald-600 text-white rounded-full font-bold transition-transform hover:scale-105">
            <Send className="w-4 h-4" /> Request Access on Telegram
          </a>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-24 border-t border-slate-800/50 bg-slate-900/20">
        <div className="max-w-3xl mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-14">Frequently asked</h2>
          <div className="space-y-3">
            <Faq q="Is it free?" a="Yes. Access is free, but granted individually — the owner approves each person to keep it available for people who genuinely need their credentials verified." />
            <Faq q="Is my card safe?" a="Your card details never leave your device. They're stored only in your browser and typed into the payment page locally — never sent to any server or to analytics." />
            <Faq q="Why do I need to be approved?" a="CIMEA releases very few request slots per day for the whole world. Individual approval keeps access with real applicants who need it." />
            <Faq q="My code stopped working after I switched computers." a="Each code is locked to one device for security. Ask the owner to reset your device and you can re-activate on the new one." />
            <Faq q="How do I reach the owner?" a="Use the Request Access bot, or message the owner directly on Telegram — the link is in the footer below." />
          </div>
        </div>
      </section>

      <footer className="py-14 text-center border-t border-slate-800/80">
        <a href={OWNER_CONTACT_URL} target="_blank" rel="noopener noreferrer"
           className="inline-flex items-center gap-2 text-slate-200 hover:text-emerald-400 font-semibold mb-4 transition-colors">
          <MessageCircle className="w-4 h-4" /> Message the owner
        </a>
        <p className="text-slate-500 text-sm">CIMEA Helper Pro · your data, your endpoint</p>
      </footer>
    </div>
  );
}

function Step({ n, title, desc }: { n: number; title: string; desc: string }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800 p-7 rounded-3xl">
      <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-500 text-slate-950 font-bold flex items-center justify-center mb-5">{n}</div>
      <h3 className="text-xl font-bold mb-2">{title}</h3>
      <p className="text-slate-400 leading-relaxed">{desc}</p>
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <details className="group bg-slate-900/50 border border-slate-800 rounded-2xl">
      <summary className="px-6 py-5 flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden font-semibold">
        {q}
        <ChevronDown className="w-5 h-5 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <p className="px-6 pb-5 -mt-1 text-slate-400 leading-relaxed">{a}</p>
    </details>
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
