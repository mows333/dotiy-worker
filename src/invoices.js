// Invoices, customers and seller settings. PDFs/XML are rendered in the admin browser
// (the free Workers plan only allows 10 ms CPU); this module stores, numbers, archives and emails them.
// GoBD: once finalized an invoice is frozen — no edits, no deletion, corrections only via credit note.
import { invoiceEmail } from './invoice-email.js';
import { sendMail } from './mail.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

const SETTINGS_DEFAULTS = {
  company: 'Dotiy', owner: 'Mohammad Al Masalmeh', street: 'Capitostraße 35', zip: '40597', city: 'Düsseldorf', country: 'DE',
  email: 'hello@dotiy.de', phone: '+49 176 70500118', website: 'dotiy.de',
  taxNumber: '', vatId: '', smallBusiness: false,
  iban: '', bic: '', bank: '', accountHolder: '',
  paymentDays: 14, invoicePrefix: 'RE', creditPrefix: 'RK', customerPrefix: 'K-',
  payLinkDefault: false, payLinkUrl: '',
  defaultIntro: 'Vielen Dank für deinen Auftrag. Für die folgenden Leistungen stelle ich dir in Rechnung:',
  defaultOutro: 'Bei Fragen zur Rechnung erreichst du mich jederzeit unter hello@dotiy.de.',
};

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...SETTINGS_DEFAULTS };
  for (const r of results) { try { s[r.key] = JSON.parse(r.value); } catch { s[r.key] = r.value; } }
  return s;
}

async function nextCounter(env, name, start = 1) {
  const row = await env.DB.prepare(
    'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value'
  ).bind(name, start).first();
  return row.value;
}

const customerOut = c => c && ({
  id: c.id, number: c.number, name: c.name, contact: c.contact, email: c.email, street: c.street, street2: c.street2,
  zip: c.zip, city: c.city, country: c.country, vatId: c.vat_id, buyerRef: c.buyer_ref, notes: c.notes, createdAt: c.created_at,
});

function invoiceOut(r) {
  if (!r) return null;
  const data = JSON.parse(r.data);
  const due = r.due_date;
  const overdue = r.status === 'open' && due && due < now().slice(0, 10);
  return {
    ...data, id: r.id, number: r.number, type: r.type, status: overdue ? 'overdue' : r.status, customerId: r.customer_id,
    total: r.total, pdfKey: r.pdf_key, finalizedAt: r.finalized_at, sentAt: r.sent_at, sentTo: r.sent_to, paidAt: r.paid_at,
    relatedId: r.related_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const DATA_FIELDS = ['type', 'taxCase', 'issueDate', 'serviceFrom', 'serviceTo', 'dueDate', 'customer', 'items', 'intro', 'outro', 'payLink', 'orderRef', 'preceding'];
const pickData = b => Object.fromEntries(DATA_FIELDS.filter(k => b[k] !== undefined).map(k => [k, b[k]]));

async function logEvent(env, id, type, detail) {
  await env.DB.prepare('INSERT INTO invoice_events (invoice_id, at, type, detail) VALUES (?, ?, ?, ?)').bind(id, now(), type, detail ?? null).run();
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function handleInvoices(request, env, url, json) {
  const path = url.pathname;
  const method = request.method;
  let m;

  /* ── Settings ─────────────────────────────────────────────────────────── */
  if (path === '/api/settings' && method === 'GET') return json(await getSettings(env));
  if (path === '/api/settings' && method === 'PUT') {
    const b = await request.json();
    const stmts = Object.keys(SETTINGS_DEFAULTS).filter(k => k in b)
      .map(k => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, JSON.stringify(b[k])));
    if (stmts.length) await env.DB.batch(stmts);
    return json(await getSettings(env));
  }

  /* ── Customers ────────────────────────────────────────────────────────── */
  if (path === '/api/customers' && method === 'GET') {
    const { results } = await env.DB.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id AND i.status != 'draft') AS invoice_count,
        (SELECT COALESCE(SUM(total),0) FROM invoices i WHERE i.customer_id = c.id AND i.type = 'invoice' AND i.status IN ('open','paid')) AS revenue
      FROM customers c ORDER BY c.name COLLATE NOCASE`).all();
    return json(results.map(r => ({ ...customerOut(r), invoiceCount: r.invoice_count, revenue: r.revenue })));
  }
  if (path === '/api/customers' && method === 'POST') {
    const b = await request.json();
    if (!b.name?.trim()) return json({ error: 'Name fehlt' }, 400);
    const s = await getSettings(env);
    const id = uid();
    const number = `${s.customerPrefix || 'K-'}${await nextCounter(env, 'customer', 1001)}`;
    await env.DB.prepare(`INSERT INTO customers (id, number, name, contact, email, street, street2, zip, city, country, vat_id, buyer_ref, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, number, b.name.trim(), b.contact || null, b.email || null, b.street || null, b.street2 || null, b.zip || null, b.city || null,
        (b.country || 'DE').toUpperCase(), b.vatId || null, b.buyerRef || null, b.notes || null, now(), now()).run();
    return json(customerOut(await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first()));
  }
  if ((m = path.match(/^\/api\/customers\/([^/]+)$/))) {
    if (method === 'PUT') {
      const b = await request.json();
      await env.DB.prepare(`UPDATE customers SET name=?, contact=?, email=?, street=?, street2=?, zip=?, city=?, country=?, vat_id=?, buyer_ref=?, notes=?, updated_at=? WHERE id=?`)
        .bind(b.name, b.contact || null, b.email || null, b.street || null, b.street2 || null, b.zip || null, b.city || null,
          (b.country || 'DE').toUpperCase(), b.vatId || null, b.buyerRef || null, b.notes || null, now(), m[1]).run();
      return json(customerOut(await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(m[1]).first()));
    }
    if (method === 'DELETE') {
      // Finalized invoices keep their own customer snapshot, so deleting the master record is safe.
      await env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(m[1]).run();
      await env.DB.prepare("DELETE FROM invoices WHERE customer_id = ? AND status = 'draft'").bind(m[1]).run();
      return json({ ok: true });
    }
  }

  /* ── Invoices ─────────────────────────────────────────────────────────── */
  if (path === '/api/invoices' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM invoices ORDER BY COALESCE(issue_date, created_at) DESC, created_at DESC').all();
    return json(results.map(invoiceOut));
  }
  if (path === '/api/invoices' && method === 'POST') {
    const b = await request.json();
    const id = uid();
    const data = pickData(b);
    await env.DB.prepare(`INSERT INTO invoices (id, type, status, customer_id, data, total, issue_date, due_date, related_id, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, data.type || 'invoice', b.customerId || null, JSON.stringify(data), Number(b.total) || 0, data.issueDate || null, data.dueDate || null, b.relatedId || null, now(), now()).run();
    await logEvent(env, id, 'created');
    return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first()));
  }

  if ((m = path.match(/^\/api\/invoices\/([^/]+)(?:\/([a-z-]+))?$/))) {
    const [, id, action] = m;
    const row = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Rechnung nicht gefunden' }, 404);
    const draft = row.status === 'draft';

    if (!action && method === 'GET') {
      const inv = invoiceOut(row);
      const { results } = await env.DB.prepare('SELECT at, type, detail FROM invoice_events WHERE invoice_id = ? ORDER BY id DESC').bind(id).all();
      return json({ ...inv, events: results });
    }

    if (!action && method === 'PUT') {
      if (!draft) return json({ error: 'Festgeschriebene Rechnungen können nicht mehr geändert werden (GoBD). Erstelle eine Rechnungskorrektur.' }, 409);
      const b = await request.json();
      const data = { ...JSON.parse(row.data), ...pickData(b) };
      await env.DB.prepare('UPDATE invoices SET data=?, customer_id=?, total=?, issue_date=?, due_date=?, type=?, updated_at=? WHERE id=?')
        .bind(JSON.stringify(data), b.customerId ?? row.customer_id, Number(b.total) || 0, data.issueDate || null, data.dueDate || null, data.type || 'invoice', now(), id).run();
      return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first()));
    }

    if (!action && method === 'DELETE') {
      if (!draft) return json({ error: 'Nur Entwürfe können gelöscht werden.' }, 409);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM invoices WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM invoice_events WHERE invoice_id = ?').bind(id),
      ]);
      return json({ ok: true });
    }

    // Assign the next gap-free number and freeze the snapshot.
    if (action === 'finalize' && method === 'POST') {
      if (!draft) return json(invoiceOut(row));
      const b = await request.json().catch(() => ({}));
      const data = { ...JSON.parse(row.data), ...pickData(b) };
      const s = await getSettings(env);
      const year = (data.issueDate || now()).slice(0, 4);
      const credit = (data.type || row.type) === 'credit';
      const prefix = credit ? (s.creditPrefix || 'RK') : (s.invoicePrefix || 'RE');
      const seq = await nextCounter(env, `${prefix}-${year}`);
      const number = `${env.IS_DEV ? 'DEV-' : ''}${prefix}-${year}-${String(seq).padStart(4, '0')}`;
      data.seller = s; // seller data as printed on the invoice
      await env.DB.prepare(`UPDATE invoices SET number=?, status='open', data=?, total=?, issue_date=?, due_date=?, finalized_at=?, updated_at=? WHERE id=?`)
        .bind(number, JSON.stringify(data), Number(b.total) || row.total, data.issueDate, data.dueDate || null, now(), now(), id).run();
      if (credit && row.related_id) {
        await env.DB.prepare("UPDATE invoices SET status='cancelled', updated_at=? WHERE id=?").bind(now(), row.related_id).run();
        await logEvent(env, row.related_id, 'cancelled', number);
      }
      await logEvent(env, id, 'finalized', number);
      return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first()));
    }

    // Archive the rendered PDF exactly once (write-once).
    if (action === 'pdf' && method === 'POST') {
      if (draft) return json({ error: 'Erst festschreiben, dann archivieren.' }, 409);
      if (row.pdf_key) return json({ ok: true, key: row.pdf_key });
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 5e6) return json({ error: 'PDF fehlt oder ist zu groß' }, 400);
      const key = `invoices/${row.number}.pdf`;
      await env.DELIVERIES.put(key, buf, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { invoice: row.number } });
      await env.DB.prepare('UPDATE invoices SET pdf_key=?, updated_at=? WHERE id=?').bind(key, now(), id).run();
      await logEvent(env, id, 'archived', key);
      return json({ ok: true, key });
    }
    if (action === 'pdf' && method === 'GET') {
      if (!row.pdf_key) return json({ error: 'Kein archiviertes PDF' }, 404);
      const obj = await env.DELIVERIES.get(row.pdf_key);
      if (!obj) return json({ error: 'PDF nicht im Archiv' }, 404);
      return new Response(obj.body, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${row.number}.pdf"` } });
    }

    if (action === 'email-preview' && method === 'POST') {
      const b = await request.json();
      const s = await getSettings(env);
      const inv = { ...invoiceOut(row), ...pickData(b), number: row.number || 'ENTWURF' };
      const mail = invoiceEmail(inv, inv.seller || s, b);
      return json(mail);
    }

    if (action === 'send' && method === 'POST') {
      if (draft) return json({ error: 'Erst festschreiben, dann senden.' }, 409);
      if (!row.pdf_key) return json({ error: 'PDF ist noch nicht archiviert.' }, 409);
      if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY fehlt im Worker.' }, 500);
      const b = await request.json();
      const to = String(b.to || '').split(/[,;\s]+/).filter(Boolean);
      if (!to.length || to.some(t => !/^\S+@\S+\.\S+$/.test(t))) return json({ error: 'Empfänger-E-Mail ist ungültig.' }, 400);
      const inv = invoiceOut(row);
      const s = inv.seller || await getSettings(env);
      const mail = invoiceEmail(inv, s, b);
      const obj = await env.DELIVERIES.get(row.pdf_key);
      const attachments = [{ filename: `${row.type === 'credit' ? 'Rechnungskorrektur' : 'Rechnung'}_${row.number}.pdf`, content: toBase64(await obj.arrayBuffer()) }];
      if (b.xml) attachments.push({ filename: `${row.number}_xrechnung.xml`, content: btoa(unescape(encodeURIComponent(b.xml))) });
      try {
        await sendMail(env, {
          from: `${s.company || 'Dotiy'} <payments@dotiy.de>`,
          to,
          cc: b.cc ? String(b.cc).split(/[,;\s]+/).filter(Boolean) : undefined,
          reply_to: s.email || 'hello@dotiy.de',
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          attachments,
        });
      } catch (e) { return json({ error: e.message }, 502); }
      await env.DB.prepare('UPDATE invoices SET sent_at=?, sent_to=?, updated_at=? WHERE id=?').bind(now(), to.join(', '), now(), id).run();
      await logEvent(env, id, 'sent', `${env.IS_DEV ? `${env.DEV_EMAIL || 'dev@dotiy.de'} (Entwicklermodus, statt ${to.join(', ')})` : to.join(', ')}${b.payLinkEnabled ? ' · mit Bezahl-Link' : ''}`);
      return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first()));
    }

    if (action === 'paid' && method === 'POST') {
      if (draft || row.status === 'cancelled') return json({ error: 'Nur offene Rechnungen können bezahlt werden.' }, 409);
      const b = await request.json().catch(() => ({}));
      const paid = b.paid === false ? null : (b.date || now().slice(0, 10));
      await env.DB.prepare('UPDATE invoices SET status=?, paid_at=?, updated_at=? WHERE id=?').bind(paid ? 'paid' : 'open', paid, now(), id).run();
      await logEvent(env, id, paid ? 'paid' : 'unpaid', paid);
      return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first()));
    }

    // Creates a credit-note draft that mirrors the invoice; finalizing it marks the original as cancelled.
    if (action === 'cancel' && method === 'POST') {
      if (draft || row.type === 'credit' || row.status === 'cancelled') return json({ error: 'Diese Rechnung kann nicht storniert werden.' }, 409);
      const existing = await env.DB.prepare("SELECT id FROM invoices WHERE related_id = ? AND status = 'draft'").bind(id).first();
      if (existing) return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(existing.id).first()));
      const src = JSON.parse(row.data);
      const newId = uid();
      const today = now().slice(0, 10);
      const data = {
        ...pickData(src), type: 'credit', issueDate: today, dueDate: today,
        preceding: { number: row.number, date: row.issue_date },
        intro: `Hiermit storniere ich die Rechnung ${row.number} vom ${row.issue_date.split('-').reverse().join('.')} vollständig.`,
        payLink: { enabled: false, url: '' },
      };
      await env.DB.prepare(`INSERT INTO invoices (id, type, status, customer_id, data, total, issue_date, due_date, related_id, created_at, updated_at)
        VALUES (?, 'credit', 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId, row.customer_id, JSON.stringify(data), row.total, today, today, id, now(), now()).run();
      await logEvent(env, newId, 'created', `Storno zu ${row.number}`);
      return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(newId).first()));
    }
  }

  return null;
}
