# CIMEA Helper Pro

A hardened, transparent fork of the CIMEA portal automation extension.

**Design principle — one hard boundary:**
- **Sensitive data (card number, CVC, cardholder name, Telegram token) stays 100% on the device.** It lives in `chrome.storage.local`, is typed into the payment form locally, and there is *no code path* that sends it anywhere.
- **Only anonymous usage statistics** are shared — and only to **your own** server.

**Access control (gated tool):** users log in with an email + password against **your** server. Automation and analytics only run while a valid session token is present; without login the tool does nothing. Accounts are **owner-provisioned** from the dashboard's **Users** page, which also shows **who reached the payment page** and when. Passwords are stored as scrypt hashes; the extension only ever holds a session token, never the password. See SETUP.md.

> Note: because the extension ships as loadable code, this gate stops casual/unauthorized use but a determined technical user could edit it to bypass client-side checks. Truly bulletproof licensing isn't possible for purely client-side automation.

**Languages:** the extension UI (popup + on-page drawer) is bilingual — **English and Russian**, with an EN/RU switch in the popup. It defaults to the browser's language. Translations live in `extension/i18n.js` (add more languages by extending that file).

```
cimea-helper-pro/
├── extension/          ← the Chrome extension (load this folder unpacked)
│   ├── manifest.json   ← MV3, permissions limited to CIMEA + Nexi + Telegram
│   ├── config.js       ← your endpoint + the privacy allowlist
│   ├── background.js   ← the ONLY code that talks to your analytics API
│   ├── content.js      ← automation on the portal (throttled, hardened)
│   ├── popup.html/.css/.js
└── dashboard/          ← your Next.js analytics API + owner dashboard (self-hosted: Coolify/Docker + PostgreSQL)
    ├── src/app/api/track/   ← receives + re-validates events, derives geo
    ├── src/app/api/stats/   ← aggregate metrics (token-gated)
    ├── src/app/api/login/   ← admin login (httpOnly cookie)
    ├── src/app/dashboard/   ← funnel, success rate, top countries, recent events
    └── src/app/lib/analytics.ts  ← shared allowlist + validation + auth
```

## What changed vs. the original

| Area | Original | Pro |
|------|----------|-----|
| Code | Obfuscated build shipped; no popup source | Fully readable, no build step, loads directly |
| Host permissions | `http://*/*` + `https://*/*` (all sites) | Only `cimea-diplome.it`, `ecommerce.nexi.it`, `api.telegram.org` |
| Tracking target | Hard-coded to the **author's** server | **Your** endpoint, configurable; off by default |
| IP/location lookup | Client calls `freeipapi.com` | Server derives country/city from request headers; raw IP hashed |
| What's tracked | event + IP + country + city | anonymous client id, session, step, retries, duration, error type + geo |
| Dashboard access | **Public** — anyone could read all IPs | Token-gated (`ADMIN_TOKEN`), httpOnly cookie |
| Server trust | Stored whatever the client sent | Re-validates against an allowlist; rejects PII / unknown fields |
| Card handling | Stored locally, auto-filled | Same, **plus** a "Wipe Card Data" button + explicit local-only notice |

See **SETUP.md** to install and deploy, and **PRIVACY.md** for the exact data flow.
