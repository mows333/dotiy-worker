// Bank sync via Enable Banking (PSD2, read-only account information).
// Secrets: EB_APP_ID (application id) and EB_PRIVATE_KEY (PEM private key of that application).
// Flow: POST /api/bank/connect → bank login → GET /api/bank/callback → session stored → transactions
// synced daily by the cron trigger and on demand. Incoming payments are matched to open invoices,
// outgoing ones are sorted into business/private with learnable rules.
import { logEvent } from './invoices.js';

const EB = 'https://api.enablebanking.com';
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const DAY = 864e5;

export const KINDS = ['open', 'business', 'private', 'income', 'transfer'];

/* ── JWT (RS256) ─────────────────────────────────────────────────────── */
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = s => b64url(new TextEncoder().encode(s));

function derLen(n) {
  if (n < 0x80) return [n];
  const out = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}

/** Accepts PKCS#8 ("BEGIN PRIVATE KEY") and PKCS#1 ("BEGIN RSA PRIVATE KEY", wrapped into PKCS#8). */
async function importKey(pem) {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  let der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  if (pkcs1) {
    const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    const octet = [0x04, ...derLen(der.length)];
    const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
    der = new Uint8Array([0x30, ...derLen(inner.length + der.length), ...inner, ...der]);
  }
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function token(env) {
  if (!env.EB_APP_ID || !env.EB_PRIVATE_KEY) throw new Error('Enable Banking ist nicht eingerichtet (EB_APP_ID / EB_PRIVATE_KEY fehlen).');
  const cached = await env.DB.prepare("SELECT value, expires_at FROM bank_state WHERE key = 'jwt'").first();
  if (cached && cached.expires_at > new Date(Date.now() + 5 * 60e3).toISOString()) return cached.value;
  const iat = Math.floor(Date.now() / 1000), exp = iat + 23 * 3600;
  const head = b64urlStr(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: env.EB_APP_ID }));
  const body = b64urlStr(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp }));
  let key;
  try { key = await importKey(env.EB_PRIVATE_KEY); }
  catch { throw new Error('EB_PRIVATE_KEY ist kein gültiger privater Schlüssel (PEM-Datei von Enable Banking komplett einfügen).'); }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  const jwt = `${head}.${body}.${b64url(sig)}`;
  await env.DB.prepare("INSERT INTO bank_state (key, value, expires_at) VALUES ('jwt', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
    .bind(jwt, new Date(exp * 1000).toISOString()).run();
  return jwt;
}

async function eb(env, method, path, body) {
  const res = await fetch(EB + path, {
    method,
    headers: { Authorization: `Bearer ${await token(env)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { message: text }; }
  if (!res.ok) {
    if (res.status === 401) await env.DB.prepare("DELETE FROM bank_state WHERE key = 'jwt'").run();
    throw new Error(`Enable Banking ${res.status}: ${data.message || data.error || data.detail || 'Fehler'}`);
  }
  return data;
}

/* ── Matching & rules ────────────────────────────────────────────────── */
const norm = s => String(s || '').toLowerCase();

async function rules(env) {
  return (await env.DB.prepare('SELECT * FROM bank_rules ORDER BY LENGTH(match) DESC').all()).results;
}

function ruleFor(list, tx) {
  const hay = `${norm(tx.counterparty)} ${norm(tx.purpose)}`;
  const dir = tx.amount > 0 ? 'in' : 'out';
  return list.find(r => r.direction === dir && hay.includes(r.match));
}

/** Incoming payment → open invoice. Strong match (amount + number in purpose) books it as paid. */
async function matchInvoice(env, tx, open) {
  const amountHits = open.filter(i => Math.abs(i.total - tx.amount) < 0.01);
  const hay = norm(`${tx.purpose} ${tx.counterparty}`).replace(/\s+/g, '');
  const byNumber = open.find(i => i.number && hay.includes(norm(i.number)));
  if (byNumber && amountHits.includes(byNumber)) return { invoice: byNumber, sure: true };
  if (byNumber) return { invoice: byNumber, sure: false };
  if (amountHits.length === 1) return { invoice: amountHits[0], sure: false };
  return null;
}

async function markPaid(env, invoiceId, date, tx) {
  const row = await env.DB.prepare("SELECT status FROM invoices WHERE id = ? AND type = 'invoice'").bind(invoiceId).first();
  if (!row || row.status !== 'open') return false;
  await env.DB.prepare("UPDATE invoices SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?").bind(date, now(), invoiceId).run();
  await logEvent(env, invoiceId, 'paid', `${date} · Zahlungseingang ${tx.counterparty ? `von ${tx.counterparty} ` : ''}per Bank erkannt`);
  return true;
}

/* ── Sync ────────────────────────────────────────────────────────────── */
async function txId(accountUid, t) {
  const ref = t.entry_reference || t.transaction_id;
  if (ref) return `${accountUid}:${ref}`;
  const raw = JSON.stringify([t.booking_date, t.value_date, t.transaction_amount, t.credit_debit_indicator, t.creditor?.name, t.debtor?.name, t.remittance_information]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return `${accountUid}:h${b64url(hash).slice(0, 22)}`;
}

function mapTx(t) {
  const out = t.credit_debit_indicator === 'DBIT';
  const amt = Math.abs(parseFloat(t.transaction_amount?.amount || '0')) * (out ? -1 : 1);
  return {
    booking_date: (t.booking_date || t.value_date || t.transaction_date || now()).slice(0, 10),
    amount: Math.round(amt * 100) / 100,
    currency: t.transaction_amount?.currency || 'EUR',
    counterparty: (out ? t.creditor?.name : t.debtor?.name) || null,
    purpose: [...(t.remittance_information || []), t.note].filter(Boolean).join(' ').trim() || null,
  };
}

async function syncAccount(env, acc) {
  const last = await env.DB.prepare('SELECT MAX(booking_date) AS d FROM bank_tx WHERE account_uid = ?').bind(acc.uid).first();
  const from = last?.d
    ? new Date(new Date(last.d).getTime() - 7 * DAY).toISOString().slice(0, 10)
    : new Date(Date.now() - 730 * DAY).toISOString().slice(0, 10);

  const fetched = [];
  let key = null, pages = 0;
  do {
    const q = new URLSearchParams({ date_from: from });
    if (key) q.set('continuation_key', key);
    const page = await eb(env, 'GET', `/accounts/${acc.uid}/transactions?${q}`);
    fetched.push(...(page.transactions || []));
    key = page.continuation_key || null;
  } while (key && ++pages < 30);

  const list = await rules(env);
  const open = (await env.DB.prepare("SELECT id, number, total FROM invoices WHERE type = 'invoice' AND status = 'open'").all()).results;
  let added = 0, paid = 0;
  const stamp = now();
  const stmts = [];
  for (const t of fetched) {
    if (t.status && t.status !== 'BOOK') continue;
    const id = await txId(acc.uid, t);
    const tx = mapTx(t);
    let kind = 'open', category = null, invoiceId = null, ruleId = null;
    const rule = ruleFor(list, tx);
    if (rule) { kind = rule.kind; category = rule.category; ruleId = rule.id; }
    if (tx.amount > 0 && kind !== 'private' && kind !== 'transfer') {
      const m = await matchInvoice(env, tx, open);
      if (m) {
        invoiceId = m.invoice.id;
        if (m.sure) {
          const exists = await env.DB.prepare('SELECT 1 FROM bank_tx WHERE id = ?').bind(id).first();
          if (!exists && await markPaid(env, m.invoice.id, tx.booking_date, tx)) {
            kind = 'income'; paid++;
            open.splice(open.indexOf(m.invoice), 1);
          }
        }
      }
    }
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO bank_tx (id, account_uid, booking_date, amount, currency, counterparty, purpose, kind, category, invoice_id, rule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, acc.uid, tx.booking_date, tx.amount, tx.currency, tx.counterparty, tx.purpose, kind, category, invoiceId, ruleId, stamp, stamp));
  }
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    added += res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
  }

  let balance = acc.balance;
  try {
    const b = await eb(env, 'GET', `/accounts/${acc.uid}/balances`);
    const pick = (b.balances || []).find(x => ['CLAV', 'ITAV', 'CLBD', 'ITBD', 'XPCD'].includes(x.balance_type)) || b.balances?.[0];
    if (pick) balance = parseFloat(pick.balance_amount.amount);
  } catch {}
  await env.DB.prepare('UPDATE bank_accounts SET last_sync = ?, last_error = NULL, balance = ? WHERE uid = ?').bind(now(), balance, acc.uid).run();
  return { added, paid };
}

export async function syncAll(env) {
  const accounts = (await env.DB.prepare('SELECT * FROM bank_accounts').all()).results;
  const out = { added: 0, paid: 0, errors: [] };
  for (const acc of accounts) {
    if (acc.valid_until && acc.valid_until < now()) { out.errors.push(`${acc.name || acc.iban}: Freigabe abgelaufen`); continue; }
    try {
      const r = await syncAccount(env, acc);
      out.added += r.added; out.paid += r.paid;
    } catch (e) {
      await env.DB.prepare('UPDATE bank_accounts SET last_error = ? WHERE uid = ?').bind(e.message, acc.uid).run();
      out.errors.push(`${acc.name || acc.iban}: ${e.message}`);
    }
  }
  return out;
}

/* ── Output ──────────────────────────────────────────────────────────── */
const txOut = r => ({
  id: r.id, accountUid: r.account_uid, date: r.booking_date, amount: r.amount, currency: r.currency,
  counterparty: r.counterparty, purpose: r.purpose, kind: r.kind, category: r.category, invoiceId: r.invoice_id,
  invoiceNumber: r.invoice_number || null, receipt: r.receipt_key ? { name: r.receipt_name } : null, note: r.note, ruleId: r.rule_id,
});
const accOut = a => ({ uid: a.uid, bank: a.aspsp, iban: a.iban, name: a.name, currency: a.currency, balance: a.balance, validUntil: a.valid_until, lastSync: a.last_sync, lastError: a.last_error });
const TX_SELECT = 'SELECT t.*, i.number AS invoice_number FROM bank_tx t LEFT JOIN invoices i ON i.id = t.invoice_id';

const ALLOWED_RETURN = /^(https:\/\/dash\.dotiy\.de|http:\/\/localhost:\d+|http:\/\/127\.0\.0\.1:\d+)(\/[^\s]*)?$/;

/* ── Public callback (the bank redirects the browser here) ───────────── */
export async function handleBankCallback(request, env, url) {
  const state = url.searchParams.get('state') || '';
  const row = await env.DB.prepare('SELECT value FROM bank_state WHERE key = ?').bind(`auth:${state}`).first();
  const ctx = row ? JSON.parse(row.value) : null;
  const back = (params) => {
    const target = new URL(ctx?.return || 'https://dash.dotiy.de/');
    target.searchParams.set('tab', 'expenses');
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    return Response.redirect(target.toString(), 302);
  };
  if (!ctx) return back({ bank: 'error', msg: 'Sitzung abgelaufen, bitte erneut verbinden.' });
  await env.DB.prepare('DELETE FROM bank_state WHERE key = ?').bind(`auth:${state}`).run();
  const error = url.searchParams.get('error');
  if (error) return back({ bank: 'error', msg: url.searchParams.get('error_description') || error });
  try {
    const s = await eb(env, 'POST', '/sessions', { code: url.searchParams.get('code') });
    const stamp = now();
    for (const a of s.accounts || []) {
      await env.DB.prepare(
        `INSERT INTO bank_accounts (uid, session_id, aspsp, iban, name, currency, valid_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET session_id = excluded.session_id, valid_until = excluded.valid_until, last_error = NULL`
      ).bind(a.uid, s.session_id, s.aspsp?.name || ctx.bank, a.account_id?.iban || null, a.name || a.product || null, a.currency || 'EUR', s.access?.valid_until || null, stamp).run();
    }
    const r = await syncAll(env);
    return back({ bank: 'ok', added: String(r.added), paid: String(r.paid) });
  } catch (e) {
    return back({ bank: 'error', msg: e.message });
  }
}

/* ── Admin API ───────────────────────────────────────────────────────── */
export async function handleBank(request, env, url, json, ctx) {
  const path = url.pathname, method = request.method;
  if (!path.startsWith('/api/bank')) return null;
  let m;

  if (path === '/api/bank/status' && method === 'GET') {
    const accounts = (await env.DB.prepare('SELECT * FROM bank_accounts ORDER BY created_at').all()).results.map(accOut);
    return json({ configured: !!(env.EB_APP_ID && env.EB_PRIVATE_KEY), accounts });
  }

  if (path === '/api/bank/aspsps' && method === 'GET') {
    const country = (url.searchParams.get('country') || 'DE').toUpperCase().slice(0, 2);
    const data = await eb(env, 'GET', `/aspsps?country=${country}&psu_type=personal`);
    return json((data.aspsps || []).map(a => ({ name: a.name, country: a.country, logo: a.logo })));
  }

  if (path === '/api/bank/connect' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const country = String(b.country || 'DE').toUpperCase().slice(0, 2);
    let bank = String(b.bank || '');
    if (!bank) {
      const list = (await eb(env, 'GET', `/aspsps?country=${country}&psu_type=personal`)).aspsps || [];
      bank = list.find(a => /revolut/i.test(a.name))?.name;
      if (!bank) return json({ error: `Revolut ist für ${country} bei Enable Banking nicht gelistet.` }, 404);
    }
    const ret = ALLOWED_RETURN.test(b.return || '') ? b.return : 'https://dash.dotiy.de/';
    const state = `${env.IS_DEV ? 'dev.' : ''}${uid()}`;
    await env.DB.prepare('INSERT INTO bank_state (key, value, expires_at) VALUES (?, ?, ?)')
      .bind(`auth:${state}`, JSON.stringify({ return: ret, bank }), new Date(Date.now() + 3600e3).toISOString()).run();
    await env.DB.prepare("DELETE FROM bank_state WHERE key LIKE 'auth:%' AND expires_at < ?").bind(now()).run();
    const callback = `${url.origin}/api/bank/callback`;
    const res = await eb(env, 'POST', '/auth', {
      access: { valid_until: new Date(Date.now() + 180 * DAY).toISOString() },
      aspsp: { name: bank, country },
      state,
      redirect_url: callback,
      psu_type: 'personal',
      language: 'de',
    });
    return json({ url: res.url });
  }

  if (path === '/api/bank/sync' && method === 'POST') return json(await syncAll(env));

  if ((m = path.match(/^\/api\/bank\/accounts\/([^/]+)$/)) && method === 'DELETE') {
    const acc = await env.DB.prepare('SELECT * FROM bank_accounts WHERE uid = ?').bind(m[1]).first();
    if (!acc) return json({ error: 'Konto nicht gefunden.' }, 404);
    const others = await env.DB.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE session_id = ? AND uid != ?').bind(acc.session_id, acc.uid).first();
    if (!others.n) { try { await eb(env, 'DELETE', `/sessions/${acc.session_id}`); } catch {} }
    await env.DB.prepare('DELETE FROM bank_accounts WHERE uid = ?').bind(acc.uid).run();
    return json({ ok: true });
  }

  if (path === '/api/bank/tx' && method === 'GET') {
    const year = url.searchParams.get('year');
    const q = year ? `${TX_SELECT} WHERE t.booking_date LIKE ? ORDER BY t.booking_date DESC, t.created_at DESC` : `${TX_SELECT} ORDER BY t.booking_date DESC, t.created_at DESC`;
    const st = env.DB.prepare(q);
    return json((await (year ? st.bind(`${year}%`) : st).all()).results.map(txOut));
  }

  if ((m = path.match(/^\/api\/bank\/tx\/([^/]+)(?:\/(receipt))?$/))) {
    const id = decodeURIComponent(m[1]);
    const row = await env.DB.prepare('SELECT * FROM bank_tx WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Umsatz nicht gefunden.' }, 404);

    if (m[2] === 'receipt') {
      if (method === 'GET') {
        if (!row.receipt_key) return json({ error: 'Kein Beleg.' }, 404);
        const obj = await env.DELIVERIES.get(row.receipt_key);
        if (!obj) return json({ error: 'Beleg nicht gefunden.' }, 404);
        return new Response(obj.body, { headers: {
          'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Disposition',
          'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'Content-Disposition': `inline; filename="${encodeURIComponent(row.receipt_name || 'beleg')}"`,
        } });
      }
      if (method === 'POST') {
        const file = (await request.formData()).get('file');
        if (!file || typeof file === 'string') return json({ error: 'Keine Datei.' }, 400);
        if (file.size > 15 * 1024 * 1024) return json({ error: 'Datei zu groß (max. 15 MB).' }, 413);
        const ext = (file.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
        // Receipts are never overwritten (GoBD): every upload gets its own key.
        const key = `${env.IS_DEV ? 'dev/' : ''}receipts/${row.booking_date.slice(0, 4)}/${uid()}.${ext}`;
        await env.DELIVERIES.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
        await env.DB.prepare('UPDATE bank_tx SET receipt_key = ?, receipt_name = ?, updated_at = ? WHERE id = ?').bind(key, file.name.slice(0, 120), now(), id).run();
        return json(txOut(await env.DB.prepare(`${TX_SELECT} WHERE t.id = ?`).bind(id).first()));
      }
    }

    if (!m[2] && method === 'PATCH') {
      const b = await request.json().catch(() => ({}));
      const kind = KINDS.includes(b.kind) ? b.kind : row.kind;
      const category = b.category !== undefined ? (b.category || null) : row.category;
      const note = b.note !== undefined ? (String(b.note || '').slice(0, 500) || null) : row.note;
      let invoiceId = b.invoiceId !== undefined ? (b.invoiceId || null) : row.invoice_id;
      if (kind !== 'income' && b.invoiceId === undefined && row.kind === 'income') invoiceId = null;
      await env.DB.prepare('UPDATE bank_tx SET kind = ?, category = ?, note = ?, invoice_id = ?, updated_at = ? WHERE id = ?')
        .bind(kind, kind === 'business' || kind === 'income' ? category : null, note, invoiceId, now(), id).run();
      if (kind === 'income' && invoiceId) await markPaid(env, invoiceId, row.booking_date, row);

      // "Immer so": store a rule and apply it to all other still-open transactions.
      let applied = 0;
      if (b.rule && (kind !== 'open')) {
        const match = norm(b.ruleMatch || row.counterparty || '').trim();
        if (match.length >= 3) {
          const ruleId = uid();
          await env.DB.prepare('DELETE FROM bank_rules WHERE match = ? AND direction = ?').bind(match, row.amount > 0 ? 'in' : 'out').run();
          await env.DB.prepare('INSERT INTO bank_rules (id, match, direction, kind, category, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(ruleId, match, row.amount > 0 ? 'in' : 'out', kind, category, now()).run();
          const sign = row.amount > 0 ? '>' : '<';
          const r = await env.DB.prepare(
            `UPDATE bank_tx SET kind = ?, category = ?, rule_id = ?, updated_at = ? WHERE kind = 'open' AND amount ${sign} 0 AND id != ?
             AND (INSTR(LOWER(COALESCE(counterparty,'')), ?) > 0 OR INSTR(LOWER(COALESCE(purpose,'')), ?) > 0)`
          ).bind(kind, kind === 'business' || kind === 'income' ? category : null, ruleId, now(), id, match, match).run();
          applied = r.meta?.changes || 0;
        }
      }
      return json({ tx: txOut(await env.DB.prepare(`${TX_SELECT} WHERE t.id = ?`).bind(id).first()), applied });
    }
  }

  if (path === '/api/bank/rules' && method === 'GET') return json(await rules(env));
  if ((m = path.match(/^\/api\/bank\/rules\/([^/]+)$/)) && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM bank_rules WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}
