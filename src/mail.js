// Single exit point for all outgoing email. In developer mode every message is
// redirected to DEV_EMAIL, so nothing ever reaches a real customer.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendMail(env, payload) {
  let p = { ...payload };
  if (env.IS_DEV) {
    const devTo = env.DEV_EMAIL || 'dev@dotiy.de';
    const original = [...(p.to || []), ...(p.cc || []), ...(p.bcc || [])].join(', ');
    const banner = `<div style="background:#ffb020;color:#111;padding:10px 16px;font:600 13px -apple-system,Segoe UI,sans-serif">ENTWICKLERMODUS · Diese E-Mail wäre gegangen an: ${esc(original)}</div>`;
    p = {
      ...p,
      to: [devTo],
      cc: undefined,
      bcc: undefined,
      reply_to: undefined,
      subject: `[DEV] ${p.subject}`,
      html: p.html && (/<body[^>]*>/i.test(p.html) ? p.html.replace(/<body[^>]*>/i, m => m + banner) : banner + p.html),
      text: `[ENTWICKLERMODUS – ursprünglich an: ${original}]\n\n${p.text || ''}`,
    };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  if (!res.ok) throw new Error(`E-Mail-Versand fehlgeschlagen: ${await res.text()}`);
  return res.json();
}
