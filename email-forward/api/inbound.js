// Encaminha para o Gmail os e-mails recebidos pelo Resend em endereços do domínio.
//
// Fluxo: Resend recebe o e-mail -> dispara o webhook "email.received" para esta
// rota -> verificamos a assinatura -> buscamos corpo e anexos -> reenviamos para
// FORWARD_TO, com "Responder para" apontando para quem escreveu.
//
// Variáveis de ambiente (Vercel -> Project -> Settings -> Environment Variables):
//   RESEND_API_KEY         chave "Full access" do Resend (precisa ler e-mails recebidos)
//   RESEND_WEBHOOK_SECRET  segredo whsec_... do webhook criado no Resend
//   FORWARD_TO             destino, ex.: suaempresa@gmail.com
//   FORWARD_ADDRESSES      endereços que devem ser encaminhados, separados por vírgula
//                          ex.: comercial@seudominio.com.br
//   FORWARD_FROM           remetente do encaminhamento (domínio verificado)
//                          ex.: comercial@seudominio.com.br
//   BRAND_NAME             (opcional) nome exibido no remetente: "Cliente via BRAND_NAME"

import { Resend } from 'resend';

// Criado sob demanda: o SDK lança erro se a chave não existir.
let resend;

const list = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// "Nome <email@x.com>" -> "email@x.com"
const bareAddress = (s) => {
  const m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
};

// "Nome <email@x.com>" -> "Nome" (ou o próprio e-mail, se não houver nome)
const displayName = (s) => {
  const m = String(s || '').match(/^\s*"?([^"<]*?)"?\s*</);
  return (m && m[1]) || bareAddress(s);
};

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function handle(request) {
  if (request.method !== 'POST') {
    const missing = ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'FORWARD_TO', 'FORWARD_ADDRESSES'].filter(
      (k) => !process.env[k],
    );
    return Response.json({ ok: missing.length === 0, missing });
  }

  if (!process.env.RESEND_API_KEY || !process.env.RESEND_WEBHOOK_SECRET) {
    console.error('RESEND_API_KEY ou RESEND_WEBHOOK_SECRET não configurados');
    return new Response('Not configured', { status: 500 });
  }
  resend ||= new Resend(process.env.RESEND_API_KEY);

  const payload = await request.text();
  const id = request.headers.get('svix-id');
  const timestamp = request.headers.get('svix-timestamp');
  const signature = request.headers.get('svix-signature');
  if (!id || !timestamp || !signature) {
    return new Response('Missing signature headers', { status: 400 });
  }

  let event;
  try {
    event = resend.webhooks.verify({
      payload,
      headers: { id, timestamp, signature },
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
    });
  } catch (err) {
    console.error('Invalid webhook signature', err);
    return new Response('Invalid signature', { status: 401 });
  }

  if (event.type !== 'email.received') {
    return Response.json({ ignored: event.type });
  }

  const data = event.data;
  const watched = list(process.env.FORWARD_ADDRESSES);
  const recipients = [...(data.to || []), ...(data.cc || []), ...(data.received_for || [])].map(bareAddress);
  const matched = recipients.find((r) => watched.includes(r));
  if (!matched) {
    return Response.json({ ignored: 'address not watched', to: data.to });
  }

  const forwardTo = list(process.env.FORWARD_TO);

  const { data: email, error: getError } = await resend.emails.receiving.get(data.email_id);
  if (getError) {
    console.error('Failed to fetch received email', getError);
    return new Response('Failed to fetch email', { status: 500 });
  }

  // Evita laço: ignora mensagens que já são um encaminhamento feito por esta função.
  const hdrs = Object.fromEntries(Object.entries(email.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (hdrs['x-email-forwarded']) {
    return Response.json({ ignored: 'already forwarded' });
  }

  // Anexos: a listagem traz URLs assinadas para download.
  let attachments = [];
  const { data: attList, error: attError } = await resend.emails.receiving.attachments.list({
    emailId: data.email_id,
  });
  if (attError) {
    console.error('Failed to list attachments (seguindo sem anexos)', attError);
  } else {
    attachments = await Promise.all(
      (attList?.data || []).map(async (a) => {
        const res = await fetch(a.download_url);
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          filename: a.filename || 'anexo',
          content: buf.toString('base64'),
          content_type: a.content_type,
          ...(a.content_disposition === 'inline' && a.content_id ? { content_id: a.content_id } : {}),
        };
      }),
    );
  }

  const header =
    `<div style="font:13px/1.5 Arial,sans-serif;color:#555;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">` +
    `<b>Recebido em:</b> ${escapeHtml(matched)}<br>` +
    `<b>De:</b> ${escapeHtml(email.from)}<br>` +
    `<b>Para:</b> ${escapeHtml((email.to || []).join(', '))}` +
    (email.cc?.length ? `<br><b>Cc:</b> ${escapeHtml(email.cc.join(', '))}` : '') +
    `</div>`;

  const textHeader =
    `Recebido em: ${matched}\nDe: ${email.from}\nPara: ${(email.to || []).join(', ')}` +
    (email.cc?.length ? `\nCc: ${email.cc.join(', ')}` : '') +
    `\n----------------------------------------\n\n`;

  const tag = matched.split('@')[0];
  const fromAddress = process.env.FORWARD_FROM || matched;

  const { data: sent, error: sendError } = await resend.emails.send({
    from: `${displayName(email.from)} via ${process.env.BRAND_NAME || 'Encaminhamento'} <${fromAddress}>`,
    to: forwardTo,
    replyTo: email.reply_to?.length ? email.reply_to : [email.from],
    headers: { 'X-Email-Forwarded': matched },
    subject: `[${tag}] ${email.subject || '(sem assunto)'}`,
    html: header + (email.html || `<pre style="white-space:pre-wrap">${escapeHtml(email.text || '')}</pre>`),
    text: textHeader + (email.text || ''),
    attachments: attachments.length ? attachments : undefined,
  });

  if (sendError) {
    console.error('Failed to forward email', sendError);
    return new Response('Failed to forward', { status: 500 });
  }

  return Response.json({ forwarded: sent?.id, to: forwardTo });
}

export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (err) {
      console.error(err);
      return new Response('Internal error', { status: 500 });
    }
  },
};
