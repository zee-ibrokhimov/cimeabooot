// =============================================================================
// GET /api/playbook  — the automation "recipe" (CIMEA/Nexi detection phrases +
// DOM selectors) that content.js needs in order to do anything.
//
// This is the Layer-3 lock: the selectors used to live hardcoded in the
// extension, so an edited/cracked copy still worked. They now live HERE and are
// only returned to a caller holding a valid session token. Effects:
//   - The extension is inert without a live login (no playbook -> no run).
//   - When CIMEA changes its page, you update PLAYBOOK here and every logged-in
//     user gets it on their next fetch — while any offline/cracked copy is stuck
//     with nothing and stops working.
//
// The extension fetches this ONCE per run and caches it (short TTL), so it adds
// no per-action latency — the click loop reads the cached copy locally.
// =============================================================================
import { NextResponse } from 'next/server';
import { verifySession, bearer } from '../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Bump this whenever you change the recipe below; the extension logs it so you
// can tell which users are on the current playbook.
const PLAYBOOK_VERSION = '2026-07-11.1';

// -----------------------------------------------------------------------------
// THE RECIPE. Everything here used to be hardcoded in the extension. Tune the
// phrases (lowercase, matched against the page text) and selectors when the
// CIMEA / Nexi pages change wording or markup.
// -----------------------------------------------------------------------------
const PLAYBOOK = {
  version: PLAYBOOK_VERSION,

  // Host fragments used to tell which site we're on.
  hosts: { cimea: 'cimea-diplome.it', nexi: 'nexi.it' },

  // Page-state detection phrases (lowercase substrings of the page text).
  detect: {
    server_error: [
      '502 bad gateway', '504 gateway time-out', '503 service unavailable',
      'service unavailable', 'internal server error',
    ],
    blocked: [
      'too many requests', 'rate limit', 'unusual traffic',
      'error 429', 'temporarily blocked',
      'troppe richieste', 'traffico insolito', 'bloccato temporaneamente',
    ],
    maintenance: [
      'under maintenance', 'site is under maintenance', 'maintenance in progress',
      'temporarily unavailable for maintenance', 'in manutenzione', 'sito in manutenzione',
    ],
    captcha_text: [
      "i'm not a robot", 'i’m not a robot', 'verify you are human', 'are you human',
      'verifica di sicurezza', 'non sono un robot',
    ],
    busy: [
      'high number of payments', 'processing a high number',
      'try again in the next minute', 'try again in the next few',
      'elevato numero di pagamenti', 'elevato numero di richieste',
      'riprova tra qualche minut', 'riprova tra pochi minut',
    ],
    no_availability: [
      'no slots available', 'no appointments available',
      'slot no longer available', 'this slot is no longer available',
      'nessun posto disponibile', 'posti esauriti', 'non ci sono slot disponibili',
    ],
    login_required: [
      'session expired', 'your session has expired', 'you have been logged out',
      'session has timed out', 'sessione scaduta', 'sessione è scaduta',
    ],
    payment_failed: [
      'payment failed', 'payment was declined', 'your payment was declined',
      'transaction failed', 'payment unsuccessful',
      'pagamento non riuscito', 'pagamento rifiutato', 'transazione fallita', 'pagamento fallito',
    ],
    success: [
      'payment successful', 'payment completed',
      'pagamento riuscito', 'pagamento completato', 'pagamento effettuato',
    ],
    daily_limit: [
      'the maximum limit of daily requests has been reached',
      'il limite massimo di richieste giornaliere',
    ],
    processing_time: [
      'select the processing time', 'processing time for your request',
      'tempo di elaborazione', 'seleziona il tempo di elaborazione',
    ],
  },

  // DOM selectors + text matchers used to drive the wizard. Strings that are
  // regex sources are marked *_re and compiled in the content script.
  selectors: {
    // "Save and next" button text (lowercase includes-match on button text).
    save_next_text: ['save and next', 'salva e continua'],
    // Processing-time (Ordinary / Urgency) radio cards.
    procedure_card: '.cd-radio-card',
    procedure_label: '.cd-radio-label',
    procedure_input: 'input.cd-radio-input',
    procedure_card_checked_class: 'cd-radio-card-checked',
    urgency_re: 'urgen',
    ordinary_re: 'ordinar',
    // Homepage / draft flow.
    home_text: ['homepage', 'home'],
    my_requests_text: 'my requests',
    draft_text: ['draft', 'bozza'],
    complete_text: ['complete', 'completa', 'complete request', 'completa richiesta'],
    // Keep-alive "stay logged in" buttons.
    keepalive_re: 'stay logged in|extend|prolunga|mantieni|continue',
    // Active CAPTCHA challenge iframe (not the always-present anchor checkbox).
    captcha_iframe_re: 'recaptcha\\/api2\\/bframe|hcaptcha\\.com\\/(?:challenge|1\\/)',
    // Card fields on the Nexi gateway (comma-lists for querySelector).
    card_number: 'input[name="cardnumber"],input[autocomplete="cc-number"],input[name="pan"]',
    card_name: 'input[autocomplete="cc-name"],input[name="cardholderName"]',
    card_cvc: 'input[autocomplete="cc-csc"],input[name="cvc"],input[name="cvv"]',
    card_exp: 'input[autocomplete="cc-exp"],input[name="exp-date"],input[name="expiry"]',
  },
};

export async function GET(request: Request) {
  const user = await verifySession(bearer(request));
  if (!user) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { ok: true, playbook: PLAYBOOK },
    { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
