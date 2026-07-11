# Setup

## 1. Deploy your server (Coolify on your home server)

The dashboard is a standard Next.js app + PostgreSQL — deploy it on your own Coolify instance (Proxmox, home server, etc.). No Vercel needed.

1. **Database** — in Coolify, add a **PostgreSQL** resource (Resources → New → PostgreSQL). Note its connection URL (`postgresql://user:pass@host:5432/db`). If the app and DB share a Coolify project, use the internal hostname.
2. **App** — add a new **Application** from your Git repo, set **Base Directory = `dashboard`**, and choose **Dockerfile** as the build pack (a `dashboard/Dockerfile` is included and produces a small standalone image). Nixpacks also works if you prefer.
3. **Environment variables** (App → Environment):
   - `DATABASE_URL` — the Postgres URL from step 1.
   - `ADMIN_TOKEN` — a long random secret (protects the owner dashboard + user management).
   - `IP_SALT` — a random string (optional; if unset, visitor IPs are not stored at all).
   - `DATABASE_SSL=true` only if your Postgres requires TLS (usually not on a LAN).
4. **Domain + HTTPS** — give the app a domain in Coolify; it provisions HTTPS via Let's Encrypt (or use a Cloudflare Tunnel). The extension **must** talk to it over **https**.
5. Deploy. Your server base is now `https://<your-domain>`.

The `users`, `sessions`, and `usage_logs` tables are created automatically on first use — no manual SQL. The app listens on port **3000**.

> Reaching your home server from users' browsers requires a public HTTPS URL — a domain pointing at your IP with port-forwarding, or (simplest for a home server) a **Cloudflare Tunnel** to the Coolify app. Cloudflare also fills in visitor country (`cf-ipcountry`).

## 2. Set up the Telegram access-code bot (owner)

Users get in by pasting a one-time **access code** the bot issues after you approve them.

1. In Telegram, create a bot with **@BotFather** and copy its **token**.
2. Get your own numeric Telegram id (message **@userinfobot**).
3. In Coolify env, set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID` (your id), and `TELEGRAM_WEBHOOK_SECRET` (any random string). Redeploy.
4. Register the webhook once:
   ```
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-domain>/api/telegram/webhook&secret_token=<SECRET>"
   ```

**How access works:**
- A user opens your bot, taps **Start → Request access**.
- You get an **Approve / Deny** message. Tap **Approve** → the bot DMs them a code like `K7QW-9F3M-2XTP`.
- They paste it into the extension and press **Activate**. The code is **device-bound** (works on one browser).
- In `/dashboard/users` you see everyone, **who reached the payment page**, a **Sharing (7d)** flag (⚠ if a code shows up from many IPs/countries), and buttons to **Disable**, **Reset device** (let them re-activate on a new device), or **Delete**. Disabling revokes sessions immediately; a disabled user is stopped mid-run within ~1 minute.

## 3. Configure + distribute the extension

1. In `extension/config.js`, set `DEFAULT_SERVER_BASE` to `https://<your-app>.vercel.app` so your users don't have to type it.
2. (Optional) Add `"https://<your-app>.vercel.app/*"` to `host_permissions` in `extension/manifest.json` so users aren't prompted to grant it. Otherwise the extension requests it at login (users click **Allow**).
3. Give users the `extension/` folder (or the zip). They load it via `chrome://extensions` → Developer mode → **Load unpacked**.

## 4. Users activate and run it

1. Users open the popup and paste the **access code** from the Telegram bot, then press **Activate**. The code is stored locally so they enter it once; the extension exchanges it for a rotating session behind the scenes.
2. They open the CIMEA portal and log into CIMEA themselves (the extension never handles the CIMEA password).
3. They click **Start Automation** — the bot works to grab a slot and drive to the payment page. Nothing runs, and no analytics is sent, unless the code is valid and active. Disabling a user or resetting their device stops them (mid-run within ~1 minute).
4. Optional card details stay on the user's device (see PRIVACY.md).

## Notes & cautions

- **Auto-retry + card autofill can submit a real payment.** Use the "Safe (5s)" speed and watch the drawer, especially near the Nexi gateway.
- Automating a government portal may conflict with CIMEA's terms of use. Use responsibly and at your own risk.
- To wipe stored card data at any time, open the popup and click **Wipe Card Data**.

## Rebuilding the download zip (optional)

The dashboard's Download button serves `dashboard/public/cimea-helper-pro.zip`. To refresh it after editing the extension, re-zip the **contents** of `extension/` (so `manifest.json` sits at the zip root):

```powershell
Compress-Archive -Path extension/* -DestinationPath dashboard/public/cimea-helper-pro.zip -Force
```
