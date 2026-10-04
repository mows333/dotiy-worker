// Developer mode (sandbox): separate D1 database + R2 bucket, emails to DEV_EMAIL.

/** Swaps every data binding to its sandbox twin. Never falls back to live data. */
export function devEnv(env) {
  if (!env.DB_DEV || !env.DEV_BUCKET) throw new Error('Entwicklermodus ist nicht eingerichtet (DB_DEV/DEV_BUCKET fehlen).');
  return { ...env, DB: env.DB_DEV, ASSETS: env.DEV_BUCKET, DELIVERIES: env.DEV_BUCKET, LIVE_DB: env.DB, IS_DEV: true };
}

const SANDBOX_TABLES = ['invoice_events', 'invoices', 'customers', 'counters', 'settings', 'deliveries', 'cases', 'posts'];
const COPY_TABLES = ['settings', 'customers', 'cases', 'posts'];

export async function handleDev(request, env, rawEnv, url, json) {
  const path = url.pathname;
  if (!path.startsWith('/api/dev/')) return null;

  if (path === '/api/dev/status' && request.method === 'GET') {
    return json({ dev: !!env.IS_DEV, email: env.DEV_EMAIL || 'dev@dotiy.de' });
  }

  // Wipes the sandbox and copies settings, customers, cases and posts from live (read-only on live).
  if (path === '/api/dev/reset' && request.method === 'POST') {
    if (!env.IS_DEV) return json({ error: 'Nur im Entwicklermodus möglich.' }, 403);
    const sandbox = env.DB_DEV;
    const live = rawEnv.DB;

    await sandbox.batch(SANDBOX_TABLES.map(t => sandbox.prepare(`DELETE FROM ${t}`)));

    let copied = 0;
    for (const table of COPY_TABLES) {
      const { results } = await live.prepare(`SELECT * FROM ${table}`).all();
      if (!results.length) continue;
      const cols = Object.keys(results[0]);
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      await sandbox.batch(results.map(r => sandbox.prepare(sql).bind(...cols.map(c => r[c]))));
      copied += results.length;
    }

    // Remove sandbox files (only ever under dev/ in the sandbox bucket)
    let cursor;
    do {
      const list = await rawEnv.DEV_BUCKET.list({ cursor, limit: 500 });
      if (list.objects.length) await rawEnv.DEV_BUCKET.delete(list.objects.map(o => o.key));
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);

    return json({ ok: true, copied });
  }

  return json({ error: 'Not found' }, 404);
}
