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

## 2. Create user accounts (owner)

1. Open `https://<your-app>.vercel.app/dashboard` and unlock with your `ADMIN_TOKEN`.
2. Go to **Users** and create an account (email + a temporary password, min 10 chars) for each person.
3. From the same page you can **disable**, **reset password**, or **delete** users, and see **who reached the payment page** and when. Disabling a user or resetting their password revokes their sessions immediately.

Sessions expire after 30 days (or 7 days idle), and users must log in again after a browser restart (the token is kept in session storage, never written to disk). A disabled user is stopped mid-run within ~1 minute.

## 3. Configure + distribute the extension

1. In `extension/config.js`, set `DEFAULT_SERVER_BASE` to `https://<your-app>.vercel.app` so your users don't have to type it.
2. (Optional) Add `"https://<your-app>.vercel.app/*"` to `host_permissions` in `extension/manifest.json` so users aren't prompted to grant it. Otherwise the extension requests it at login (users click **Allow**).
3. Give users the `extension/` folder (or the zip). They load it via `chrome://extensions` → Developer mode → **Load unpacked**.

## 4. Users sign in and run it

1. Users open the popup and **log in** with the email + password you gave them. The password is sent to your server for login only and is **never stored**; the extension keeps just a session token.
2. They open the CIMEA portal and log into CIMEA themselves (the extension never handles the CIMEA password).
3. They click **Start Automation** — the bot works to grab a slot and drive to the payment page. Nothing runs, and no analytics is sent, unless the session is valid. Disabling a user or resetting their password signs them out everywhere.
4. Optional card + Telegram details stay on the user's device (see PRIVACY.md).

## Notes & cautions

- **Auto-retry + card autofill can submit a real payment.** Use the "Safe (5s)" speed and watch the drawer, especially near the Nexi gateway.
- Automating a government portal may conflict with CIMEA's terms of use. Use responsibly and at your own risk.
- To wipe stored card data at any time, open the popup and click **Wipe Card Data**.

## Rebuilding the download zip (optional)

The dashboard's Download button serves `dashboard/public/cimea-helper-pro.zip`. To refresh it after editing the extension, re-zip the **contents** of `extension/` (so `manifest.json` sits at the zip root):

```powershell
Compress-Archive -Path extension/* -DestinationPath dashboard/public/cimea-helper-pro.zip -Force
```
