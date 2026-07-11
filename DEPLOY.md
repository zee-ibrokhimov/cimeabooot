# Deploying to your own server (Coolify on Proxmox)

Two paths. **Path A (Coolify + Git)** is recommended — Coolify manages HTTPS and
restarts. **Path B (docker-compose)** runs the whole stack with one command on any
Docker host.

Generate your own secrets (don't reuse examples):
```
# on any machine with node:
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```
You need three: `ADMIN_TOKEN`, `IP_SALT`, and a Postgres password.

---

## Path A — Coolify + Git (recommended)

### 1. Put the code on a Git host
The repo is already initialized locally. Create an **empty private repo** on
GitHub (or your own Gitea), then from `cimea-helper-pro/`:
```
git remote add origin https://github.com/<you>/cimea-helper-pro.git
git push -u origin main
```

### 2. Create the database in Coolify
- Project → **+ New** → **Database** → **PostgreSQL** → create.
- Open it, copy the **internal connection URL** (looks like
  `postgres://postgres:PASSWORD@<host>:5432/postgres`). You'll paste this as
  `DATABASE_URL`.

### 3. Create the application in Coolify
- Project → **+ New** → **Application** → **Private/Public Repository** → your repo URL.
- **Build Pack:** Dockerfile
- **Base Directory:** `/dashboard`
- **Port (Exposes):** `3000`
- **Environment Variables:**
  - `DATABASE_URL` = the internal URL from step 2
  - `ADMIN_TOKEN` = your secret
  - `IP_SALT` = your secret
  - (`DATABASE_SSL=true` only if your DB requires TLS — usually not internally)
- **Domain:** set your FQDN (e.g. `https://cimea.yourdomain.com`). Coolify issues
  the Let's Encrypt certificate.
- **Deploy.**

Tables (`users`, `sessions`, `usage_logs`) create themselves on first use.

---

## Path B — docker-compose (any Docker host / Proxmox LXC)

On a machine with Docker + the repo copied over:
```
cp .env.compose.example .env      # then edit .env with your secrets
docker compose up -d --build
```
The app is on `http://SERVER_IP:3000`. Put HTTPS in front of it (Coolify proxy,
a Cloudflare Tunnel, or your own nginx/Caddy). Update with `git pull &&
docker compose up -d --build`.

---

## 4. Exposing a home server over HTTPS (pick one)

The extension **must** reach the server over `https://`.
- **Cloudflare Tunnel (easiest, no port-forwarding):** install `cloudflared` (or
  the Coolify one-click), point a tunnel at the app (`http://localhost:3000` or the
  Coolify service), map it to `cimea.yourdomain.com`. Free TLS; also fills in
  visitor country (`cf-ipcountry`).
- **Domain + port-forward:** point an A record at your public IP, forward 443 to
  the Coolify proxy, let Coolify get the cert.

## 5. Point the extension at your server
- In `extension/config.js` set:
  ```
  DEFAULT_SERVER_BASE: "https://cimea.yourdomain.com",
  ```
- Reload the extension (`chrome://extensions` → refresh). Users can also enter the
  URL in the popup on first login.

## 6. First run
1. Open `https://cimea.yourdomain.com/dashboard`, unlock with `ADMIN_TOKEN`.
2. **Users** → create accounts (email + password ≥ 10 chars).
3. In the extension popup, log in → **Start Automation**.

## Troubleshooting
- **Dashboard shows a DB error banner:** `DATABASE_URL` is wrong/unreachable, or
  (for Path A) the app and DB aren't in the same Coolify project/network. Use the
  DB's **internal** URL, not the public one.
- **"Set the ADMIN_TOKEN…" on /dashboard:** the env var isn't set on the app; add it and redeploy.
- **Extension login does nothing / CORS:** the server base must be reachable over
  HTTPS from the browser; confirm the domain resolves and the cert is valid.
- **Login rate-limit acting per-user oddly:** ensure your proxy forwards
  `X-Forwarded-For` (Coolify/Traefik does by default).
- **Country/city always empty:** expected without GeoIP; Cloudflare Tunnel adds country.
