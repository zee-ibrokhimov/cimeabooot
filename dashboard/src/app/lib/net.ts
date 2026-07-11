// =============================================================================
// Client IP derivation — correct for a self-hosted proxy chain, NOT Vercel.
//
// Cloudflare Tunnel (the recommended way to expose a home server) sets
// cf-connecting-ip / true-client-ip and OVERWRITES any client-supplied value,
// so those are trustworthy. Without Cloudflare, x-real-ip / X-Forwarded-For are
// only trustworthy if your reverse proxy (Traefik/Coolify) is configured to
// strip client-supplied X-Forwarded-For / X-Real-Ip headers.
//
// Treat this as best-effort: the EMAIL-based login lockout is the primary
// brute-force control and does not depend on the IP being trustworthy.
// =============================================================================
export function clientIp(h: Headers): string {
  const cf = h.get('cf-connecting-ip') || h.get('true-client-ip');
  if (cf) return cf.trim();
  const real = h.get('x-real-ip');
  if (real) return real.trim();
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim(); // rightmost hop, not the spoofable leftmost
  }
  return 'unknown';
}
