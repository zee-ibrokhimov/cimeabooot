// =============================================================================
// Database access — standard PostgreSQL via `pg`.
//
// This is a drop-in replacement for @vercel/postgres's `sql` tagged template,
// so the rest of the app is unchanged. It builds a parameterized query from the
// template (values become $1, $2, … — never string-concatenated, so it is
// injection-safe) and returns { rows } just like @vercel/postgres did.
//
// Point it at your own Postgres (e.g. a Coolify Postgres service) with the
// DATABASE_URL environment variable.
// =============================================================================
import { Pool, type QueryResultRow } from 'pg';

// Reuse a single pool across hot-reloads / requests.
const globalForPg = globalThis as unknown as { _cimeaPool?: Pool };

// TLS to Postgres:
//   DATABASE_SSL unset/false -> no TLS (fine on a trusted private network).
//   DATABASE_SSL=true        -> TLS WITH certificate verification (secure).
//                               Provide DATABASE_CA_CERT for a self-signed / internal CA.
//   DATABASE_SSL_INSECURE=true-> TLS without verification (last resort only).
function dbSsl(): false | { rejectUnauthorized: boolean; ca?: string } {
  if (process.env.DATABASE_SSL_INSECURE === 'true') return { rejectUnauthorized: false };
  if (process.env.DATABASE_SSL === 'true') {
    return { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT || undefined };
  }
  return false;
}

function pool(): Pool {
  if (!globalForPg._cimeaPool) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — point it at your Postgres instance.');
    }
    globalForPg._cimeaPool = new Pool({
      connectionString,
      ssl: dbSsl(),
      max: Number(process.env.DATABASE_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForPg._cimeaPool;
}

export async function sql<T extends QueryResultRow = QueryResultRow>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) {
    text += '$' + (i + 1) + strings[i + 1];
  }
  const res = await pool().query<T>(text, values as unknown[]);
  return { rows: res.rows, rowCount: res.rowCount ?? 0 };
}
