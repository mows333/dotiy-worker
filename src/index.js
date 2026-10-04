import { handleInvoices } from './invoices.js';

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') return new Response(null, { headers: cors });

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

    const isAdmin = () =>
      request.headers.get('Authorization') === `Bearer ${env.ADMIN_SECRET}`;

    try {

      // ── dash.dotiy.de → proxy admin panel from Pages ──────────────────────
      const host = request.headers.get('host') || '';
      if (host === 'dash.dotiy.de') {
        const targetPath = (url.pathname === '/' || url.pathname === '') ? '/admin' : url.pathname;
        const targetUrl  = `https://dotiy.pages.dev${targetPath}${url.search}`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 20000);
        try {
          const res = await fetch(new Request(targetUrl, {
            method:   request.method,
            headers:  { 'user-agent': request.headers.get('user-agent') || '' },
            signal:   ac.signal,
            redirect: 'manual',
          }));
          clearTimeout(timer);
          return res;
        } catch (err) {
          clearTimeout(timer);
          return new Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Admin — nicht erreichbar</title></head>' +
            '<body style="font-family:sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;">' +
            '<p style="font-size:1.1rem;opacity:.7">Admin-Panel konnte nicht geladen werden.</p>' +
            '<p style="font-size:.85rem;opacity:.4">dotiy.pages.dev nicht erreichbar. Bitte kurz warten und neu laden.</p>' +
            '</body></html>',
            { status: 503, headers: { ...cors, 'Content-Type': 'text/html;charset=utf-8' } }
          );
        }
      }

      // ── Public: GET /assets/:key — serve file from R2 (with Range support) ─
      const assetMatch = path.match(/^\/assets\/(.+)$/);
      if (assetMatch && method === 'GET') {
        const key         = assetMatch[1];
        const rangeHeader = request.headers.get('Range');
        const getOptions  = {};

        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (m) {
            const offset = parseInt(m[1]);
            const end    = m[2] !== '' ? parseInt(m[2]) : undefined;
            getOptions.range = { offset, ...(end !== undefined ? { length: end - offset + 1 } : {}) };
          }
        }

        const obj = await env.ASSETS.get(key, getOptions);
        if (!obj) return new Response('Not found', { status: 404, headers: cors });

        const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
        const headers     = new Headers(cors);
        headers.set('Content-Type',   contentType);
        headers.set('Accept-Ranges',  'bytes');
        headers.set('Cache-Control',  'public, max-age=31536000, immutable');

        if (getOptions.range) {
          const { offset, length } = getOptions.range;
          const total    = obj.size;
          const last     = length !== undefined ? offset + length - 1 : total - 1;
          headers.set('Content-Range',  `bytes ${offset}-${last}/${total}`);
          headers.set('Content-Length', String(last - offset + 1));
          return new Response(obj.body, { status: 206, headers });
        }

        if (obj.size) headers.set('Content-Length', String(obj.size));
        return new Response(obj.body, { headers });
      }

      // ── Public: GET /api/cases ─────────────────────────────────────────
      if (path === '/api/cases' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM cases WHERE published = 1 ORDER BY display_order ASC, id DESC'
        ).all();
        return json(results);
      }

      // ── Public: GET /api/posts ─────────────────────────────────────────
      if (path === '/api/posts' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT id, slug, title, excerpt, meta_description, published_at FROM posts WHERE published = 1 ORDER BY published_at DESC'
        ).all();
        return json(results);
      }

      // ── Public: GET /api/posts/:slug ───────────────────────────────────
      const slugMatch = path.match(/^\/api\/posts\/([^/]+)$/);
      if (slugMatch && method === 'GET') {
        const post = await env.DB.prepare(
          'SELECT * FROM posts WHERE slug = ? AND published = 1'
        ).bind(slugMatch[1]).first();
        if (!post) return json({ error: 'Not found' }, 404);
        return json(post);
      }

      // ── Public: GET /d/:token — delivery info (for download page) ──────
      const deliverTokenMatch = path.match(/^\/d\/([^/]+)$/);
      if (deliverTokenMatch && method === 'GET') {
        const token    = deliverTokenMatch[1];
        const delivery = await env.DB.prepare(
          `SELECT id, client_name, files, message, expires_at, download_count,
           (password_hash IS NOT NULL) as has_password
           FROM deliveries WHERE token = ?`
        ).bind(token).first();

        if (!delivery) return json({ error: 'Not found' }, 404);
        if (new Date(delivery.expires_at) < new Date()) return json({ error: 'Expired' }, 410);

        return json({
          ...delivery,
          files: JSON.parse(delivery.files).map(f => ({ name: f.name, size: f.size })),
        });
      }

      // ── Public: POST /d/:token/verify — check password ─────────────────
      const deliverVerifyMatch = path.match(/^\/d\/([^/]+)\/verify$/);
      if (deliverVerifyMatch && method === 'POST') {
        const token    = deliverVerifyMatch[1];
        const { password } = await request.json();
        const delivery = await env.DB.prepare(
          'SELECT password_hash FROM deliveries WHERE token = ?'
        ).bind(token).first();

        if (!delivery) return json({ error: 'Not found' }, 404);
        if (!delivery.password_hash) return json({ ok: true });

        const hash = await _sha256(password);
        if (hash !== delivery.password_hash) return json({ error: 'Falsches Passwort' }, 403);
        return json({ ok: true });
      }

      // ── Public: GET /d/:token/file/:filename — stream download ──────────
      const deliverFileMatch = path.match(/^\/d\/([^/]+)\/file\/(.+)$/);
      if (deliverFileMatch && method === 'GET') {
        const [, token, filename] = deliverFileMatch;
        const delivery = await env.DB.prepare(
          'SELECT files, expires_at, password_hash FROM deliveries WHERE token = ?'
        ).bind(token).first();

        if (!delivery) return new Response('Not found', { status: 404, headers: cors });
        if (new Date(delivery.expires_at) < new Date()) return new Response('Link abgelaufen', { status: 410, headers: cors });

        // Password check via query param
        if (delivery.password_hash) {
          const pw = url.searchParams.get('pw');
          if (!pw) return new Response('Unauthorized', { status: 401, headers: cors });
          const hash = await _sha256(pw);
          if (hash !== delivery.password_hash) return new Response('Unauthorized', { status: 401, headers: cors });
        }

        const files    = JSON.parse(delivery.files);
        const fileInfo = files.find(f => f.name === decodeURIComponent(filename));
        if (!fileInfo) return new Response('Not found', { status: 404, headers: cors });

        const obj = await env.DELIVERIES.get(fileInfo.key);
        if (!obj) return new Response('Not found', { status: 404, headers: cors });

        await env.DB.prepare(
          'UPDATE deliveries SET download_count = download_count + 1 WHERE token = ?'
        ).bind(token).run();

        const headers = new Headers(cors);
        headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('Content-Disposition', `attachment; filename="${fileInfo.name}"`);
        if (obj.size) headers.set('Content-Length', String(obj.size));
        return new Response(obj.body, { headers });
      }

      // ── All routes below require admin auth ────────────────────────────
      if (!isAdmin()) return json({ error: 'Unauthorized' }, 401);

      // ── Admin: POST /api/upload — upload asset to ASSETS bucket ────────
      if (path === '/api/upload' && method === 'POST') {
        const formData = await request.formData();
        const file     = formData.get('file');
        if (!file) return json({ error: 'No file' }, 400);

        const ext     = file.name.split('.').pop().toLowerCase();
        const mimeMap = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          gif: 'image/gif',  webp: 'image/webp', mp4: 'video/mp4',
          mov: 'video/quicktime', svg: 'image/svg+xml',
        };
        const mime   = mimeMap[ext] || file.type || 'application/octet-stream';
        const folder = formData.get('folder') || 'uploads';
        const key    = `${folder}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

        await env.ASSETS.put(key, file.stream(), {
          httpMetadata: { contentType: mime },
        });

        return json({ url: `https://dotiy-api.dev-ac6.workers.dev/assets/${key}`, key });
      }

      // ── Admin: POST /api/deliver/upload — upload file to DELIVERIES bucket
      if (path === '/api/deliver/upload' && method === 'POST') {
        const formData   = await request.formData();
        const file       = formData.get('file');
        const deliveryId = formData.get('delivery_id') || crypto.randomUUID();
        if (!file) return json({ error: 'No file' }, 400);

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const key      = `deliveries/${deliveryId}/${safeName}`;

        await env.DELIVERIES.put(key, file.stream(), {
          httpMetadata: { contentType: file.type || 'application/octet-stream' },
        });

        return json({ key, name: file.name, size: file.size, delivery_id: deliveryId });
      }

      // ── Admin: POST /api/deliver — create delivery + send email ─────────
      if (path === '/api/deliver' && method === 'POST') {
        const b = await request.json();
        const { client_name, client_email, files, password, message, expires_days = 14 } = b;

        if (!client_name || !client_email || !files?.length) {
          return json({ error: 'client_name, client_email und files sind Pflichtfelder' }, 400);
        }

        const id            = crypto.randomUUID();
        const token         = _generateToken();
        const password_hash = password ? await _sha256(password) : null;
        const expires_at    = new Date(Date.now() + expires_days * 24 * 60 * 60 * 1000).toISOString();
        const created_at    = new Date().toISOString();
        const filesJson     = JSON.stringify(files);

        await env.DB.prepare(
          `INSERT INTO deliveries (id, token, client_name, client_email, files, password_hash, message, expires_at, download_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
        ).bind(id, token, client_name, client_email, filesJson, password_hash, message ?? null, expires_at, created_at).run();

        await _sendDeliveryEmail(env, {
          clientName: client_name, clientEmail: client_email,
          token, files: filesJson, message, expiresAt: expires_at,
          hasPassword: !!password,
        });

        return json({ id, token, url: `https://dotiy.de/deliver/${token}` });
      }

      // ── Admin: GET /api/delivers — list all deliveries ──────────────────
      if (path === '/api/delivers' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT id, token, client_name, client_email, files, message,
           expires_at, download_count, created_at,
           (password_hash IS NOT NULL) as has_password
           FROM deliveries ORDER BY created_at DESC`
        ).all();
        return json(results.map(d => ({ ...d, files: JSON.parse(d.files) })));
      }

      // ── Admin: DELETE /api/deliver/:id — delete delivery + files ────────
      const deliverIdMatch = path.match(/^\/api\/deliver\/([^/]+)$/);
      if (deliverIdMatch && method === 'DELETE') {
        const id       = deliverIdMatch[1];
        const delivery = await env.DB.prepare(
          'SELECT files FROM deliveries WHERE id = ?'
        ).bind(id).first();

        if (delivery) {
          const files = JSON.parse(delivery.files);
          await Promise.all(files.map(f => env.DELIVERIES.delete(f.key)));
        }
        await env.DB.prepare('DELETE FROM deliveries WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      // ── Admin: PATCH /api/deliver/:id — extend expiry ───────────────────
      if (deliverIdMatch && method === 'PATCH') {
        const b          = await request.json();
        const days       = b.expires_days || 14;
        const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare(
          'UPDATE deliveries SET expires_at = ? WHERE id = ?'
        ).bind(expires_at, deliverIdMatch[1]).run();
        return json({ ok: true, expires_at });
      }

      // ── Admin: GET /api/admin/cases ─────────────────────────────────────
      if (path === '/api/admin/cases' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM cases ORDER BY display_order ASC, id DESC'
        ).all();
        return json(results);
      }

      // ── Admin: POST /api/cases ──────────────────────────────────────────
      if (path === '/api/cases' && method === 'POST') {
        const b = await request.json();
        const r = await env.DB.prepare(
          'INSERT INTO cases (title, subtitle, description, tags, image_url, link, display_order, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(b.title, b.subtitle ?? null, b.description ?? null, b.tags ?? null, b.image_url ?? null, b.link ?? null, b.display_order ?? 0, b.published ?? 1).run();
        return json({ id: r.meta.last_row_id });
      }

      // ── Admin: PUT /api/cases/:id ───────────────────────────────────────
      const caseIdMatch = path.match(/^\/api\/cases\/(\d+)$/);
      if (caseIdMatch && method === 'PUT') {
        const b = await request.json();
        await env.DB.prepare(
          'UPDATE cases SET title=?, subtitle=?, description=?, tags=?, image_url=?, link=?, display_order=?, published=? WHERE id=?'
        ).bind(b.title, b.subtitle ?? null, b.description ?? null, b.tags ?? null, b.image_url ?? null, b.link ?? null, b.display_order ?? 0, b.published ?? 1, parseInt(caseIdMatch[1])).run();
        return json({ ok: true });
      }

      // ── Admin: DELETE /api/cases/:id ────────────────────────────────────
      if (caseIdMatch && method === 'DELETE') {
        await env.DB.prepare('DELETE FROM cases WHERE id = ?').bind(parseInt(caseIdMatch[1])).run();
        return json({ ok: true });
      }

      // ── Admin: GET /api/admin/posts ─────────────────────────────────────
      if (path === '/api/admin/posts' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM posts ORDER BY created_at DESC'
        ).all();
        return json(results);
      }

      // ── Admin: GET /api/admin/post/:id ──────────────────────────────────
      const adminPostIdMatch = path.match(/^\/api\/admin\/post\/(\d+)$/);
      if (adminPostIdMatch && method === 'GET') {
        const post = await env.DB.prepare(
          'SELECT * FROM posts WHERE id = ?'
        ).bind(parseInt(adminPostIdMatch[1])).first();
        if (!post) return json({ error: 'Not found' }, 404);
        return json(post);
      }

      // ── Admin: POST /api/posts ──────────────────────────────────────────
      if (path === '/api/posts' && method === 'POST') {
        const b = await request.json();
        const r = await env.DB.prepare(
          'INSERT INTO posts (slug, title, excerpt, body, meta_description, image_url, published, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(b.slug, b.title, b.excerpt ?? null, b.body ?? null, b.meta_description ?? null, b.image_url ?? null, b.published ?? 0, b.published ? new Date().toISOString() : null).run();
        return json({ id: r.meta.last_row_id });
      }

      // ── Admin: PUT /api/posts/:id ───────────────────────────────────────
      const postIdMatch = path.match(/^\/api\/posts\/(\d+)$/);
      if (postIdMatch && method === 'PUT') {
        const b = await request.json();
        await env.DB.prepare(
          'UPDATE posts SET slug=?, title=?, excerpt=?, body=?, meta_description=?, image_url=?, published=?, published_at=? WHERE id=?'
        ).bind(b.slug, b.title, b.excerpt ?? null, b.body ?? null, b.meta_description ?? null, b.image_url ?? null, b.published ?? 0, b.published_at ?? null, parseInt(postIdMatch[1])).run();
        return json({ ok: true });
      }

      // ── Admin: DELETE /api/posts/:id ────────────────────────────────────
      if (postIdMatch && method === 'DELETE') {
        await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(parseInt(postIdMatch[1])).run();
        return json({ ok: true });
      }

      const invoiceRes = await handleInvoices(request, env, url, json);
      if (invoiceRes) return invoiceRes;

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

function _generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function _sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function _sendDeliveryEmail(env, { clientName, clientEmail, token, files, message, expiresAt, hasPassword }) {
  const downloadUrl  = `https://dotiy.de/deliver/${token}`;
  const parsedFiles  = JSON.parse(files);
  const fileList     = parsedFiles.map(f => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #1a1a1a; color: #ccc;">${f.name}</td>
      <td style="padding: 10px 0; border-bottom: 1px solid #1a1a1a; color: #555; text-align: right;">${_formatSize(f.size)}</td>
    </tr>`).join('');
  const expiryDate  = new Date(expiresAt).toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:48px 24px;">

    <div style="margin-bottom:40px;">
      <img src="https://dotiy.de/images/logo.svg" alt="Dotiy" height="18" style="filter:invert(1);">
    </div>

    <h1 style="font-size:22px;font-weight:600;color:#fff;margin:0 0 8px;">Hallo ${clientName},</h1>
    <p style="font-size:15px;color:#666;margin:0 0 32px;line-height:1.6;">
      Deine Projektdateien von Dotiy sind fertig und bereit zum Download.
    </p>

    ${message ? `
    <div style="background:#111;border-radius:12px;padding:16px 20px;margin-bottom:28px;">
      <p style="color:#999;font-size:14px;line-height:1.6;margin:0;">${message}</p>
    </div>` : ''}

    <div style="background:#111;border-radius:12px;padding:16px 20px;margin-bottom:28px;">
      <p style="font-size:12px;color:#555;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.08em;">Enthaltene Dateien</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">${fileList}</table>
    </div>

    ${hasPassword ? `
    <div style="background:#1a1200;border:1px solid #332200;border-radius:10px;padding:12px 16px;margin-bottom:24px;">
      <p style="color:#cc9900;font-size:13px;margin:0;">🔒 Dieser Download ist passwortgeschützt. Du hast das Passwort separat erhalten.</p>
    </div>` : ''}

    <a href="${downloadUrl}" style="display:inline-block;background:#fff;color:#000;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px;margin-bottom:28px;">
      Dateien herunterladen
    </a>

    <p style="font-size:13px;color:#444;margin:0 0 4px;">Link gültig bis: ${expiryDate}</p>
    <p style="font-size:13px;color:#333;margin:0;">Bei Fragen: <a href="mailto:hello@dotiy.de" style="color:#666;">hello@dotiy.de</a></p>

    <div style="margin-top:48px;padding-top:24px;border-top:1px solid #1a1a1a;">
      <p style="font-size:12px;color:#333;margin:0;">Dotiy Studio · Düsseldorf · <a href="https://dotiy.de" style="color:#444;">dotiy.de</a></p>
    </div>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Dotiy Studio <hello@dotiy.de>',
      to:   [clientEmail],
      subject: `Deine Dateien von Dotiy sind bereit — ${clientName}`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend: ${err}`);
  }
  return res.json();
}
