// Invoice email. Two variants: with a pay button (payLink enabled) or bank transfer only.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const eur = n => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n || 0);
const dateDE = iso => (iso ? iso.split('-').reverse().join('.') : '');

export function invoiceEmail(inv, s, opts = {}) {
  const credit = inv.type === 'credit';
  const kind = credit ? 'Rechnungskorrektur' : 'Rechnung';
  const payUrl = opts.payLinkEnabled ?? inv.payLink?.enabled ? (opts.payLinkUrl || inv.payLink?.url) : '';
  const pay = !credit && /^https:\/\//.test(payUrl || '');
  const greeting = inv.customer?.contact ? `Hallo ${inv.customer.contact.split(' ')[0]},` : 'Hallo,';
  const message = (opts.message ?? '').trim();
  const subject = opts.subject || `${kind} ${inv.number} von ${s.company || 'Dotiy'}`;
  const amount = eur(inv.total);

  const intro = message
    ? esc(message).replace(/\n/g, '<br>')
    : credit
      ? `anbei erhältst du die ${kind} ${esc(inv.number)} zur Rechnung ${esc(inv.preceding?.number || '')}.`
      : `anbei erhältst du die Rechnung ${esc(inv.number)} über <b>${amount}</b>. Vielen Dank für deinen Auftrag!`;

  const row = (k, v) => `<tr><td style="padding:6px 0;color:#6b6b6f;font-size:14px;">${k}</td><td style="padding:6px 0;text-align:right;font-size:14px;font-weight:600;color:#111;">${v}</td></tr>`;
  const bank = `
    <table role="presentation" width="100%" style="border-collapse:collapse;">
      ${row('Empfänger', esc(s.accountHolder || s.owner || s.company))}
      ${row('IBAN', esc(s.iban))}
      ${s.bic ? row('BIC', esc(s.bic)) : ''}
      ${row('Verwendungszweck', esc(inv.number))}
    </table>`;

  const payBlock = credit ? '' : pay ? `
    <table role="presentation" width="100%" style="margin:28px 0 8px;"><tr><td align="center">
      <a href="${esc(payUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:16px 34px;border-radius:999px;">Jetzt ${amount} bezahlen</a>
    </td></tr></table>
    <p style="margin:0 0 24px;text-align:center;font-size:13px;color:#6b6b6f;">Sicher online bezahlen.</p>
    <div style="background:#f4f4f5;border-radius:16px;padding:18px 20px;">
      <p style="margin:0 0 8px;font-size:13px;color:#6b6b6f;">Lieber per Überweisung? Bitte bis ${dateDE(inv.dueDate)} an:</p>
      ${bank}
    </div>` : `
    <div style="background:#f4f4f5;border-radius:16px;padding:18px 20px;margin:28px 0 0;">
      <p style="margin:0 0 8px;font-size:14px;color:#111;font-weight:600;">Bitte überweise ${amount} bis zum ${dateDE(inv.dueDate)}:</p>
      ${bank}
      <p style="margin:12px 0 0;font-size:13px;color:#6b6b6f;">Tipp: Den GiroCode auf der Rechnung kannst du mit deiner Banking-App scannen.</p>
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eeeef0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111;">
  <table role="presentation" width="100%" style="background:#eeeef0;"><tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:24px;">
      <tr><td style="padding:32px 32px 8px;">
        <img src="https://dotiy.de/images/logo-mail.png" width="96" alt="${esc(s.company || 'Dotiy')}" style="display:block;border:0;">
      </td></tr>
      <tr><td style="padding:16px 32px 32px;">
        <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#6b6b6f;text-transform:uppercase;letter-spacing:.06em;">${kind} ${esc(inv.number)}</p>
        <p style="margin:0 0 20px;font-size:30px;font-weight:800;letter-spacing:-.02em;">${amount}</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${greeting}</p>
        <p style="margin:0;font-size:15px;line-height:1.6;">${intro}</p>
        <table role="presentation" width="100%" style="border-collapse:collapse;margin-top:24px;border-top:1px solid #eee;">
          ${row(`${kind}s-Nr.`, esc(inv.number))}
          ${row('Datum', dateDE(inv.issueDate))}
          ${credit ? '' : row('Fällig am', dateDE(inv.dueDate))}
          ${row('Betrag', amount)}
        </table>
        ${payBlock}
        <p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#6b6b6f;">Die ${kind} hängt als PDF an. Sie ist eine E-Rechnung im ZUGFeRD-Format (EN 16931) und kann direkt in Buchhaltungssoftware übernommen werden.</p>
        <p style="margin:24px 0 0;font-size:15px;line-height:1.6;">Viele Grüße<br>${esc(s.owner || s.company)}</p>
      </td></tr>
    </table>
    <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#8a8a90;">${esc([s.company, s.street, `${s.zip} ${s.city}`].filter(Boolean).join(' · '))}<br>${esc(s.email)}${s.website ? ` · ${esc(s.website)}` : ''}</p>
  </td></tr></table>
</body></html>`;

  const text = [
    greeting, '',
    message || (credit ? `anbei erhältst du die ${kind} ${inv.number}.` : `anbei erhältst du die Rechnung ${inv.number} über ${amount}.`), '',
    credit ? '' : (pay ? `Jetzt bezahlen: ${payUrl}\n\nOder per Überweisung bis ${dateDE(inv.dueDate)}:` : `Bitte überweise ${amount} bis zum ${dateDE(inv.dueDate)}:`),
    credit ? '' : `Empfänger: ${s.accountHolder || s.owner || s.company}\nIBAN: ${s.iban}${s.bic ? `\nBIC: ${s.bic}` : ''}\nVerwendungszweck: ${inv.number}`,
    '', `Viele Grüße\n${s.owner || s.company}`,
  ].join('\n');

  return { subject, html, text };
}
