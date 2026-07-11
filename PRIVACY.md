# Privacy & data flow

This document states exactly what data leaves the device and what does not.

## Stays on the device (never transmitted to your analytics API)

Stored in `chrome.storage.local`, read only by local automation:

- `cardName`, `cardNum`, `cardExp`, `cardCvc` — typed into the payment form on this device only.
- `tgToken`, `tgChatId` — used only to call `api.telegram.org` for **your own** notifications.

Guarantees:
1. The analytics sender (`sendAnalytics` in `background.js`) builds its payload from a fixed **allowlist** (`ANALYTICS_ALLOWED_FIELDS`). The sensitive keys are not in it.
2. There is no code that reads a card/token key and passes it into `sendAnalytics`.
3. Defense in depth: before sending, `isPayloadSafe()` rejects the payload if any key or value matches a sensitive pattern (`card`, `cvc`, `token`, …) or looks like a card number (`\d{12,}`).
4. The **server** independently re-validates (`sanitizeEvent` in `lib/analytics.ts`) and drops anything sensitive or off-allowlist — so even a tampered client can't inject PII.

## Shared with your analytics API (only if you enable it)

Analytics is sent **only** when (a) you set an endpoint and (b) the "Share usage statistics" toggle is on. The payload is exactly:

| Field | Example | Notes |
|-------|---------|-------|
| `event` | `payment_success` | one of a fixed set of event names |
| `clientId` | `3f9c…` (random UUID) | anonymous, generated locally, no PII |
| `sessionId` | `s_…` | random id for one automation run |
| `extVersion` | `2.0.0` | |
| `step` | `payment_page` | coarse label |
| `retries` | `12` | number of retry clicks |
| `durationMs` | `84000` | run length |
| `errorType` | `server_5xx` | coarse label |
| `ts` | ISO timestamp | |

The **server** additionally derives, from the network request (not the client body):

- `country`, `city` — from Vercel geo headers.
- `ip_hash` — a salted SHA-256 of the caller IP. The raw IP is **not** stored, and hashing is **fail-closed**: if `IP_SALT` is unset, no IP-derived value is stored at all (`ip_hash = null`).

## Abuse controls & retention

- `POST /api/track` re-validates every field to a strict format and rejects unknown/sensitive data (`sanitizeEvent`).
- Best-effort per-IP rate limiting, a 4 KB body cap, and an optional shared `INGEST_KEY` reduce spam. A browser extension cannot hold a real secret, so treat stored analytics as untrusted telemetry, not ground truth.
- **Retention is not automatic.** To cap growth, prune periodically, e.g. `DELETE FROM usage_logs WHERE created_at < NOW() - INTERVAL '90 days';`.

## Authentication data

- The login **password** is sent to your server only to log in and is **never stored** by the extension.
- The **session token** is kept in `chrome.storage.session` — it is not written to disk and is not readable by the CIMEA/Nexi page context (content scripts can't access it). It is cleared on logout, on browser restart, on server revocation, and by server-side session expiry (30-day absolute / 7-day idle).
- Server-side: passwords are stored as scrypt hashes; only the **SHA-256 hash** of a session token is stored (a DB leak yields no usable tokens).

## Third-party contact

- Your own Vercel endpoint (analytics) — opt-in.
- `api.telegram.org` — only if you configure a Telegram bot, for your own alerts.
- The CIMEA and Nexi sites themselves — that's where automation runs.

The original extension's `freeipapi.com` lookup and its hard-coded author tracking URL have been removed.
