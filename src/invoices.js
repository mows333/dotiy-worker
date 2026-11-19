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
  paymentDays: 14, invoicePrefix: 'RE', creditPrefix: 'RK', customerPrefix: 'C', offerPrefix: 'AN', orderPrefix: 'AB', offerValidDays: 30,
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

// Customer numbers: prefix + 2-digit year + 3-digit sequence per year (e.g. C26005).
// Derived from existing numbers, so imports and the sandbox can never collide.
async function nextCustomerNumber(env, prefix) {
  const head = `${prefix}${String(new Date().getFullYear()).slice(2)}`;
  const row = await env.DB.prepare('SELECT MAX(CAST(SUBSTR(number, ?) AS INTEGER)) AS n FROM customers WHERE number LIKE ?')
    .bind(head.length + 1, `${head}%`).first();
  return `${head}${String((row?.n || 0) + 1).padStart(3, '0')}`;
}

// Invoice numbers in the old system's style: one letter + 2-digit year + 3-digit sequence (I26028).
// Derived from the numbers that already exist, so the imported old invoices (…I26027) are continued without gaps.
async function nextLegacyInvoiceNumber(env, prefix, year, minNext = '') {
  const head = `${prefix}${String(year).slice(2)}`;
  const row = await env.DB.prepare("SELECT MAX(CAST(SUBSTR(number, ?) AS INTEGER)) AS n FROM invoices WHERE number GLOB ?")
    .bind(head.length + 1, `${head}[0-9][0-9][0-9]*`).first();
  // Optional floor, e.g. invoiceNextMin = "I26030": the next number is at least that — only within that prefix/year.
  const floor = String(minNext || '').startsWith(head) ? parseInt(String(minNext).slice(head.length), 10) || 0 : 0;
  return `${head}${String(Math.max((row?.n || 0) + 1, floor)).padStart(3, '0')}`;
}

// Offer / order-confirmation numbers: letter (A = Angebot, B = Bestätigung) + last digit of the year + MMDD + running number
// of that day (A611191 = Angebot vom 19.11.2026, das erste des Tages). They carry the issue date and a per-day count only,
// so the total number of offers sent can't be read off them. Derived from existing numbers → never collides.
async function nextQuoteNumber(env, letter, issueDate) {
  const d = String(issueDate || now()).slice(0, 10);   // YYYY-MM-DD
  const head = `${letter}${d.slice(3, 4)}${d.slice(5, 7)}${d.slice(8, 10)}`;
  const row = await env.DB.prepare('SELECT MAX(CAST(SUBSTR(number, ?) AS INTEGER)) AS n FROM invoices WHERE number GLOB ?')
    .bind(head.length + 1, `${head}[0-9]*`).first();
  return `${head}${(row?.n || 0) + 1}`;
}

async function nextCounter(env, name, start = 1) {
  const row = await env.DB.prepare(
    'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value'
  ).bind(name, start).first();
  return row.value;
}

const customerOut = c => c && ({
  id: c.id, number: c.number, name: c.name, contact: c.contact, email: c.email, phone: c.phone, street: c.street, street2: c.street2,
  zip: c.zip, city: c.city, country: c.country, vatId: c.vat_id, buyerRef: c.buyer_ref, notes: c.notes, createdAt: c.created_at,
});

// Document types: invoice, credit (Rechnungskorrektur/Storno), offer (Angebot), order (Auftragsbestätigung).
// Offers and order confirmations share numbering, freezing (GoBD) and archiving with invoices.
export const DOC = {
  invoice: { label: 'Rechnung', prefix: s => s.invoicePrefix || 'RE' },
  credit: { label: 'Rechnungskorrektur', prefix: s => s.creditPrefix || 'RK' },
  offer: { label: 'Angebot', prefix: s => s.offerPrefix || 'AN' },
  order: { label: 'Auftragsbestätigung', prefix: s => s.orderPrefix || 'AB' },
};
const QUOTES = ['offer', 'order'];
const ORDER_INTRO = 'Vielen Dank für deinen Auftrag! Hiermit bestätige ich die folgenden Leistungen zu den genannten Konditionen:';

function invoiceOut(r) {
  if (!r) return null;
  const data = JSON.parse(r.data);
  const due = r.due_date;
  const today = now().slice(0, 10);
  // Only invoices can be overdue; an open offer past its validity is shown as expired.
  const overdue = r.type === 'invoice' && r.status === 'open' && due && due < today;
  const expired = r.type === 'offer' && r.status === 'open' && due && due < today;
  const credited = Number(r.credited) || 0;
  return {
    ...data, id: r.id, number: r.number, type: r.type, status: overdue ? 'overdue' : expired ? 'expired' : r.status, customerId: r.customer_id,
    credited, amountDue: Math.round((r.total - credited) * 100) / 100,
    total: r.total, pdfKey: r.pdf_key, finalizedAt: r.finalized_at, sentAt: r.sent_at, sentTo: r.sent_to, paidAt: r.paid_at,
    relatedId: r.related_id, createdAt: r.created_at, updatedAt: r.updated_at,
    remindedAt: r.reminded_at ?? null, reminderCount: r.reminder_count ?? 0,
  };
}

const DATA_FIELDS = ['type', 'taxCase', 'issueDate', 'serviceFrom', 'serviceTo', 'dueDate', 'paymentDays', 'validUntil', 'customer', 'items', 'discount', 'intro', 'outro', 'payLink', 'orderRef', 'preceding', 'basedOn'];
const pickData = b => Object.fromEntries(DATA_FIELDS.filter(k => b[k] !== undefined).map(k => [k, b[k]]));

// Reminder stats come from the event log, so no schema change is needed.
const SELECT_INV = `SELECT i.*,
  (SELECT MAX(at) FROM invoice_events e WHERE e.invoice_id = i.id AND e.type = 'reminder') AS reminded_at,
  (SELECT COUNT(*) FROM invoice_events e WHERE e.invoice_id = i.id AND e.type = 'reminder') AS reminder_count,
  (SELECT COALESCE(SUM(k.total), 0) FROM invoices k WHERE k.related_id = i.id AND k.type = 'credit' AND k.status != 'draft') AS credited
  FROM invoices i`;
const getInvoice = (env, id) => env.DB.prepare(`${SELECT_INV} WHERE i.id = ?`).bind(id).first();

export async function logEvent(env, id, type, detail) {
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
      FROM customers c ORDER BY c.number DESC, c.name COLLATE NOCASE`).all();
    return json(results.map(r => ({ ...customerOut(r), invoiceCount: r.invoice_count, revenue: r.revenue })));
  }
  if (path === '/api/customers' && method === 'POST') {
    const b = await request.json();
    if (!b.name?.trim()) return json({ error: 'Name fehlt' }, 400);
    const s = await getSettings(env);
    const id = uid();
    const number = await nextCustomerNumber(env, s.customerPrefix ?? 'C');
    await env.DB.prepare(`INSERT INTO customers (id, number, name, contact, email, phone, street, street2, zip, city, country, vat_id, buyer_ref, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, number, b.name.trim(), b.contact || null, b.email || null, b.phone || null, b.street || null, b.street2 || null, b.zip || null, b.city || null,
        (b.country || 'DE').toUpperCase(), b.vatId || null, b.buyerRef || null, b.notes || null, now(), now()).run();
    return json(customerOut(await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first()));
  }
  // Interessent → Kunde: legt aus dem Empfänger eines Belegs einen Kunden an und verknüpft
  // alle Belege ohne Kunden-ID mit gleicher E-Mail bzw. gleichem Namen (nur die Verknüpfung, Snapshots bleiben unverändert).
  if (path === '/api/customers/from-document' && method === 'POST') {
    const b = await request.json();
    const row = b.invoiceId && await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(b.invoiceId).first();
    if (!row) return json({ error: 'Beleg nicht gefunden' }, 404);
    if (row.customer_id) return json({ error: 'Der Empfänger ist bereits ein Kunde.' }, 409);
    const c = JSON.parse(row.data).customer;
    if (!c?.name?.trim()) return json({ error: 'Beleg hat keinen Empfänger.' }, 400);
    const s = await getSettings(env);
    const id = uid();
    const number = await nextCustomerNumber(env, s.customerPrefix ?? 'C');
    await env.DB.prepare(`INSERT INTO customers (id, number, name, contact, email, phone, street, street2, zip, city, country, vat_id, buyer_ref, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, number, c.name.trim(), c.contact || null, c.email || null, c.phone || null, c.street || null, c.street2 || null, c.zip || null, c.city || null,
        (c.country || 'DE').toUpperCase(), c.vatId || null, c.buyerRef || null, null, now(), now()).run();
    const mail = (c.email || '').trim().toLowerCase(), name = c.name.trim().toLowerCase();
    const { results } = await env.DB.prepare('SELECT id, data FROM invoices WHERE customer_id IS NULL').all();
    const linked = results.filter(r => {
      if (r.id === row.id) return true;
      const x = JSON.parse(r.data).customer || {};
      return mail ? (x.email || '').trim().toLowerCase() === mail : (x.name || '').trim().toLowerCase() === name;
    }).map(r => r.id);
    if (linked.length) await env.DB.batch(linked.map(i => env.DB.prepare('UPDATE invoices SET customer_id = ?, updated_at = ? WHERE id = ?').bind(id, now(), i)));
    return json({ ...customerOut(await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first()), linked: linked.length });
  }
  if ((m = path.match(/^\/api\/customers\/([^/]+)$/))) {
    if (method === 'PUT') {
      const b = await request.json();
      await env.DB.prepare(`UPDATE customers SET name=?, contact=?, email=?, phone=?, street=?, street2=?, zip=?, city=?, country=?, vat_id=?, buyer_ref=?, notes=?, updated_at=? WHERE id=?`)
        .bind(b.name, b.contact || null, b.email || null, b.phone || null, b.street || null, b.street2 || null, b.zip || null, b.city || null,
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
  if ((path === '/api/invoices' || path === '/api/offers') && method === 'GET') {
    const types = path === '/api/offers' ? "('offer','order')" : "('invoice','credit')";
    const { results } = await env.DB.prepare(`${SELECT_INV} WHERE i.type IN ${types} ORDER BY COALESCE(i.issue_date, i.created_at) DESC, i.created_at DESC`).all();
    return json(results.map(invoiceOut));
  }
  if (path === '/api/invoices' && method === 'POST') {
    const b = await request.json();
    const id = uid();
    const data = pickData(b);
    if (!DOC[data.type || 'invoice']) return json({ error: 'Unbekannte Belegart.' }, 400);
    await env.DB.prepare(`INSERT INTO invoices (id, type, status, customer_id, data, total, issue_date, due_date, related_id, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, data.type || 'invoice', b.customerId || null, JSON.stringify(data), Number(b.total) || 0, data.issueDate || null, data.dueDate || null, b.relatedId || null, now(), now()).run();
    await logEvent(env, id, 'created');
    return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first()));
  }

  if ((m = path.match(/^\/api\/invoices\/([^/]+)(?:\/([a-z-]+))?$/))) {
    const [, id, action] = m;
    const row = await getInvoice(env, id);
    if (!row) return json({ error: 'Beleg nicht gefunden' }, 404);
    const kind = (DOC[row.type] || DOC.invoice).label;
    const draft = row.status === 'draft';
    // Imported legacy invoices (sent before the dashboard existed) are view-only: no edits, mails or status changes.
    if (JSON.parse(row.data).imported && method !== 'GET') return json({ error: 'Importierte Altrechnung – nur Ansicht.' }, 409);

    if (!action && method === 'GET') {
      const inv = invoiceOut(row);
      const { results } = await env.DB.prepare('SELECT at, type, detail FROM invoice_events WHERE invoice_id = ? ORDER BY id DESC').bind(id).all();
      return json({ ...inv, events: results });
    }

    if (!action && method === 'PUT') {
      if (!draft) return json({ error: QUOTES.includes(row.type) ? `Festgeschriebene Belege können nicht mehr geändert werden (GoBD). Erstelle eine neue Version.` : 'Festgeschriebene Rechnungen können nicht mehr geändert werden (GoBD). Erstelle eine Rechnungskorrektur.' }, 409);
      const b = await request.json();
      const data = { ...JSON.parse(row.data), ...pickData(b) };
      await env.DB.prepare('UPDATE invoices SET data=?, customer_id=?, total=?, issue_date=?, due_date=?, type=?, updated_at=? WHERE id=?')
        .bind(JSON.stringify(data), ('customerId' in b ? (b.customerId || null) : row.customer_id), Number(b.total) || 0, data.issueDate || null, data.dueDate || null, data.type || 'invoice', now(), id).run();
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
      const type = row.type;
      const credit = type === 'credit';
      const prefix = (DOC[type] || DOC.invoice).prefix(s);
      data.seller = s; // seller data as printed on the invoice
      const total = Number(b.total) || row.total;
      const src = row.related_id ? await getInvoice(env, row.related_id) : null;
      let status = 'open';
      // All checks happen before the number is drawn, so a rejected finalize never leaves a gap.
      if (credit && src && total > Math.round((src.total - (Number(src.credited) || 0)) * 100) / 100 + 0.005) {
        return json({ error: `Die Korrektur (${total.toFixed(2)} €) ist höher als der noch offene Rechnungsbetrag (${(src.total - (Number(src.credited) || 0)).toFixed(2)} €).` }, 409);
      }
      if (credit && src && src.status === 'cancelled') return json({ error: 'Die Rechnung ist bereits storniert.' }, 409);
      // Single-letter invoice prefix (e.g. "I") → old style I26028; anything else → RE-2026-0001.
      // Single-letter prefixes use the short style: invoices I26030, credits (Storno/Korrektur) S26001 — each with its own sequence.
      // Offers/orders use the date-based short code.
      const legacy = (type === 'invoice' || type === 'credit') && /^[A-Z]$/.test(prefix);
      let base;
      if (legacy) base = await nextLegacyInvoiceNumber(env, prefix, year, s.invoiceNextMin);
      else if (QUOTES.includes(type) && /^[A-Z]$/.test(prefix)) base = await nextQuoteNumber(env, prefix, data.issueDate);
      else base = `${prefix}-${year}-${String(await nextCounter(env, `${prefix}-${year}`)).padStart(4, '0')}`;
      const number = `${env.IS_DEV ? 'DEV-' : ''}${base}`;

      // Storno / correction: a full correction cancels the invoice. If the invoice was not paid yet nothing
      // has to be refunded, so the correction is settled right away; if it was paid, it is "to refund".
      if (credit && src) {
        const remaining = Math.round((src.total - (Number(src.credited) || 0)) * 100) / 100;
        data.fullCancel = total >= remaining - 0.005 && !(Number(src.credited) > 0);
        data.originalPaid = src.status === 'paid';
        status = data.originalPaid ? 'open' : 'settled';
      }
      await env.DB.prepare(`UPDATE invoices SET number=?, status=?, data=?, total=?, issue_date=?, due_date=?, finalized_at=?, updated_at=? WHERE id=?`)
        .bind(number, status, JSON.stringify(data), total, data.issueDate, data.dueDate || null, now(), now(), id).run();
      await logEvent(env, id, 'finalized', number);

      if (credit && src) {
        const remaining = Math.round((src.total - (Number(src.credited) || 0) - total) * 100) / 100;
        if (remaining <= 0.005) {
          await env.DB.prepare("UPDATE invoices SET status='cancelled', updated_at=? WHERE id=?").bind(now(), src.id).run();
          await logEvent(env, src.id, 'cancelled', number);
        } else {
          await logEvent(env, src.id, 'corrected', `${number} · −${total.toFixed(2)} €, noch ${remaining.toFixed(2)} €`);
        }
        if (status === 'settled') await logEvent(env, id, 'settled', `mit ${src.number} verrechnet`);
      }
      // Follow-up documents move their source along: offer → new version / order confirmation / invoice.
      if (src && type === 'offer' && src.type === 'offer' && ['open', 'declined'].includes(src.status)) {
        await env.DB.prepare("UPDATE invoices SET status='superseded', updated_at=? WHERE id=?").bind(now(), src.id).run();
        await logEvent(env, src.id, 'superseded', number);
      }
      if (src && type === 'order' && src.type === 'offer' && src.status === 'open') {
        await env.DB.prepare("UPDATE invoices SET status='accepted', updated_at=? WHERE id=?").bind(now(), src.id).run();
        await logEvent(env, src.id, 'accepted', `Auftragsbestätigung ${number}`);
      }
      if (src && type === 'invoice' && QUOTES.includes(src.type) && ['open', 'accepted'].includes(src.status)) {
        await env.DB.prepare("UPDATE invoices SET status='invoiced', updated_at=? WHERE id=?").bind(now(), src.id).run();
        await logEvent(env, src.id, 'invoiced', number);
      }
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
      const attachments = [{ filename: `${kind.replace(/[^\wäöüÄÖÜß]+/g, '')}_${row.number}.pdf`, content: toBase64(await obj.arrayBuffer()) }];
      if (b.xml && !QUOTES.includes(row.type)) attachments.push({ filename: `${row.number}_xrechnung.xml`, content: btoa(unescape(encodeURIComponent(b.xml))) });
      try {
        await sendMail(env, {
          from: `${s.company || 'Dotiy'} <payments@dotiy.de>`,
          to,
          // dev@dotiy.de always gets a copy of sent invoices
          cc: [...new Set([...(b.cc ? String(b.cc).split(/[,;\s]+/).filter(Boolean) : []), env.DEV_EMAIL || 'dev@dotiy.de'])],
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

    // Payment reminder: same invoice PDF again, friendly text, new deadline. Logged as 'reminder' event.
    const canRemind = row.type === 'invoice' && row.status === 'open';
    const reminderOpts = b => {
      const deadline = /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || '') ? b.deadline : new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
      return { ...b, reminder: { level: (row.reminder_count || 0) + 1, deadline } };
    };

    if (action === 'reminder-preview' && method === 'POST') {
      if (!canRemind) return json({ error: 'Erinnerungen gibt es nur für offene Rechnungen.' }, 409);
      const b = await request.json();
      const inv = invoiceOut(row);
      return json(invoiceEmail(inv, inv.seller || await getSettings(env), reminderOpts(b)));
    }

    if (action === 'reminder' && method === 'POST') {
      if (!canRemind) return json({ error: 'Erinnerungen gibt es nur für offene Rechnungen.' }, 409);
      if (!row.pdf_key) return json({ error: 'PDF ist noch nicht archiviert.' }, 409);
      if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY fehlt im Worker.' }, 500);
      const b = await request.json();
      const to = String(b.to || '').split(/[,;\s]+/).filter(Boolean);
      if (!to.length || to.some(t => !/^\S+@\S+\.\S+$/.test(t))) return json({ error: 'Empfänger-E-Mail ist ungültig.' }, 400);
      const inv = invoiceOut(row);
      const s = inv.seller || await getSettings(env);
      const o = reminderOpts(b);
      const mail = invoiceEmail(inv, s, o);
      const obj = await env.DELIVERIES.get(row.pdf_key);
      if (!obj) return json({ error: 'PDF nicht im Archiv' }, 404);
      try {
        await sendMail(env, {
          from: `${s.company || 'Dotiy'} <payments@dotiy.de>`,
          to,
          cc: [...new Set([...(b.cc ? String(b.cc).split(/[,;\s]+/).filter(Boolean) : []), env.DEV_EMAIL || 'dev@dotiy.de'])],
          reply_to: s.email || 'hello@dotiy.de',
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          attachments: [{ filename: `Rechnung_${row.number}.pdf`, content: toBase64(await obj.arrayBuffer()) }],
        });
      } catch (e) { return json({ error: e.message }, 502); }
      await logEvent(env, id, 'reminder', `${o.reminder.level}. Erinnerung an ${env.IS_DEV ? `${env.DEV_EMAIL || 'dev@dotiy.de'} (Entwicklermodus, statt ${to.join(', ')})` : to.join(', ')} · Frist ${o.reminder.deadline.split('-').reverse().join('.')}`);
      return json(invoiceOut(await getInvoice(env, id)));
    }

    if (action === 'paid' && method === 'POST') {
      if (draft || row.status === 'cancelled' || QUOTES.includes(row.type) || row.status === 'settled') return json({ error: 'Nur offene Rechnungen können bezahlt werden.' }, 409);
      const b = await request.json().catch(() => ({}));
      const paid = b.paid === false ? null : (b.date || now().slice(0, 10));
      await env.DB.prepare('UPDATE invoices SET status=?, paid_at=?, updated_at=? WHERE id=?').bind(paid ? 'paid' : 'open', paid, now(), id).run();
      await logEvent(env, id, paid ? 'paid' : 'unpaid', paid);
      return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first()));
    }

    // Offer outcome set by hand (accepted / declined), or back to open.
    if (action === 'status' && method === 'POST') {
      if (row.type !== 'offer' || draft) return json({ error: 'Nur festgeschriebene Angebote haben einen Status.' }, 409);
      const b = await request.json().catch(() => ({}));
      const next = { accepted: 'accepted', declined: 'declined', open: 'open' }[b.status];
      if (!next || !['open', 'accepted', 'declined'].includes(row.status)) return json({ error: 'Dieser Status ist hier nicht möglich.' }, 409);
      await env.DB.prepare('UPDATE invoices SET status=?, updated_at=? WHERE id=?').bind(next, now(), id).run();
      await logEvent(env, id, next === 'open' ? 'reopened' : next, b.note || null);
      return json(invoiceOut(await getInvoice(env, id)));
    }

    // Follow-up document as a draft: offer → new version / order confirmation / invoice, order → invoice.
    // The source changes its status only when the new document is finalized.
    if ((action === 'convert' || action === 'revise') && method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const to = action === 'revise' ? 'offer' : b.to;
      const allowed = row.type === 'offer' ? ['offer', 'order', 'invoice'] : row.type === 'order' ? ['invoice'] : [];
      if (draft || !allowed.includes(to) || ['superseded', 'invoiced'].includes(row.status)) return json({ error: 'Daraus kann gerade kein neuer Beleg erstellt werden.' }, 409);
      const existing = await env.DB.prepare("SELECT id FROM invoices WHERE related_id = ? AND type = ? AND status = 'draft'").bind(id, to).first();
      if (existing) return json(invoiceOut(await getInvoice(env, existing.id)));
      const s = await getSettings(env);
      const src = JSON.parse(row.data);
      const today = now().slice(0, 10);
      const days = Number(src.paymentDays ?? s.paymentDays) || 14;
      const data = {
        ...pickData(src), type: to, issueDate: today, preceding: undefined, seller: undefined,
        basedOn: { type: row.type, number: row.number, date: row.issue_date },
        intro: to === 'invoice' ? s.defaultIntro : to === 'order' ? ORDER_INTRO : src.intro,
        outro: to === 'invoice' ? s.defaultOutro : src.outro,
        payLink: to === 'invoice' ? { enabled: !!s.payLinkDefault && !!s.payLinkUrl, url: s.payLinkUrl || '' } : undefined,
        paymentDays: days,
      };
      if (to === 'invoice') { data.dueDate = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10); data.serviceFrom = src.serviceFrom || today; }
      if (to === 'offer') data.validUntil = new Date(Date.now() + (Number(s.offerValidDays) || 30) * 864e5).toISOString().slice(0, 10);
      data.dueDate = to === 'offer' ? data.validUntil : data.dueDate || null;
      const newId = uid();
      await env.DB.prepare(`INSERT INTO invoices (id, type, status, customer_id, data, total, issue_date, due_date, related_id, created_at, updated_at)
        VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId, to, row.customer_id, JSON.stringify(data), row.total, today, data.dueDate, id, now(), now()).run();
      await logEvent(env, newId, 'created', `${action === 'revise' ? 'Neue Version von' : 'Aus'} ${DOC[row.type].label} ${row.number}`);
      return json(invoiceOut(await getInvoice(env, newId)));
    }

    // Creates a credit-note draft that mirrors the invoice; finalizing it marks the original as cancelled.
    if (action === 'cancel' && method === 'POST') {
      if (draft || row.type !== 'invoice' || row.status === 'cancelled') return json({ error: 'Diese Rechnung kann nicht storniert werden.' }, 409);
      const left = Math.round((row.total - (Number(row.credited) || 0)) * 100) / 100;
      if (left <= 0.005) return json({ error: 'Diese Rechnung ist bereits vollständig korrigiert.' }, 409);
      const existing = await env.DB.prepare("SELECT id FROM invoices WHERE related_id = ? AND status = 'draft'").bind(id).first();
      if (existing) return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(existing.id).first()));
      const src = JSON.parse(row.data);
      const newId = uid();
      const today = now().slice(0, 10);
      // After a partial correction only the rest is left: one line "Restbetrag" instead of all original items.
      let items = src.items;
      const rates = [...new Set((src.items || []).map(it => Number(it.vat ?? 19)))];
      if (Number(row.credited) > 0 && rates.length <= 1) {
        const rate = src.taxCase === 'standard' || !src.taxCase ? (rates[0] ?? 19) : 0;
        const net = Math.floor((left / (1 + rate / 100)) * 100) / 100;
        items = [{ name: `Restbetrag zu Rechnung ${row.number}`, description: '', qty: 1, unit: 'LS', price: net, vat: rates[0] ?? 19 }];
      }
      const data = {
        ...pickData(src), type: 'credit', issueDate: today, dueDate: today, basedOn: undefined,
        items,
        preceding: { number: row.number, date: row.issue_date },
        // Draft hints for the preview; recomputed when the correction is finalized.
        originalDue: left, originalPaid: row.status === 'paid', fullCancel: !(Number(row.credited) > 0),
        intro: `Hiermit storniere ich die Rechnung ${row.number} vom ${row.issue_date.split('-').reverse().join('.')}${Number(row.credited) > 0 ? ' (Restbetrag)' : ''}.`,
        payLink: { enabled: false, url: '' },
      };
      await env.DB.prepare(`INSERT INTO invoices (id, type, status, customer_id, data, total, issue_date, due_date, related_id, created_at, updated_at)
        VALUES (?, 'credit', 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId, row.customer_id, JSON.stringify(data), Number(row.credited) > 0 ? left : row.total, today, today, id, now(), now()).run();
      await logEvent(env, newId, 'created', `Storno zu ${row.number}`);
      return json(invoiceOut(await env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(newId).first()));
    }
  }

  return null;
}
