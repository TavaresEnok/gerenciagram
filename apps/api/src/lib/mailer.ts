import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Envio de e-mail transacional (verificação de conta, convite, reset de
 * senha, notificações da SPEC seção 6).
 *
 * Em dev aponta para o Mailpit, que captura tudo e não entrega para fora —
 * nenhum e-mail de teste chega a um endereço real por acidente.
 */

export interface MailerConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  verify(): Promise<boolean>;
}

export function createMailer(config: MailerConfig): Mailer {
  const transporter: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.password
      ? { auth: { user: config.user, pass: config.password } }
      : {}),
    // Timeout explícito: um SMTP travado não pode segurar a resposta da API.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return {
    async send(message) {
      await transporter.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
    },
    async verify() {
      try {
        await transporter.verify();
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
//  Modelos de mensagem
// ---------------------------------------------------------------------------

function layout(title: string, body: string, actionUrl?: string, actionLabel?: string): string {
  const button = actionUrl
    ? `<p style="margin:24px 0"><a href="${actionUrl}" style="background:#111827;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${actionLabel ?? 'Abrir'}</a></p>
       <p style="color:#6b7280;font-size:13px">Se o botão não funcionar, copie este endereço:<br><span style="word-break:break-all">${actionUrl}</span></p>`
    : '';

  return `<!doctype html><html lang="pt-BR"><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;color:#111827;max-width:520px;margin:0 auto;padding:24px">
  <h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
  ${body}
  ${button}
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0">
  <p style="color:#9ca3af;font-size:12px">Você recebeu este e-mail porque tem uma conta no Gerenciador de Redes Sociais.</p>
</body></html>`;
}

export function emailVerificationMessage(to: string, url: string): MailMessage {
  return {
    to,
    subject: 'Confirme seu e-mail',
    text: `Confirme seu e-mail acessando: ${url}\n\nO link expira em 24 horas.`,
    html: layout(
      'Confirme seu e-mail',
      '<p>Falta um passo para ativar sua conta. O link abaixo expira em 24 horas.</p>',
      url,
      'Confirmar e-mail',
    ),
  };
}

export function passwordResetMessage(to: string, url: string): MailMessage {
  return {
    to,
    subject: 'Redefinir sua senha',
    text: `Para redefinir sua senha, acesse: ${url}\n\nO link expira em 1 hora. Se não foi você, ignore este e-mail.`,
    html: layout(
      'Redefinir sua senha',
      '<p>Recebemos um pedido para redefinir sua senha. O link expira em 1 hora.</p><p>Se não foi você, pode ignorar este e-mail — sua senha continua a mesma.</p>',
      url,
      'Redefinir senha',
    ),
  };
}

export function organizationInviteMessage(
  to: string,
  organizationName: string,
  inviterName: string,
  url: string,
): MailMessage {
  return {
    to,
    subject: `${inviterName} convidou você para ${organizationName}`,
    text: `${inviterName} convidou você para a organização "${organizationName}".\n\nAceite em: ${url}`,
    html: layout(
      `Convite para ${organizationName}`,
      `<p><strong>${inviterName}</strong> convidou você para participar da organização <strong>${organizationName}</strong>.</p>`,
      url,
      'Aceitar convite',
    ),
  };
}

export function publishFailedMessage(
  to: string,
  accountLabel: string,
  platformName: string,
  reason: string,
  url: string,
): MailMessage {
  return {
    to,
    subject: `Falha ao publicar em ${accountLabel}`,
    text: `A publicação em ${accountLabel} (${platformName}) falhou.\n\nMotivo: ${reason}\n\nDetalhes: ${url}`,
    html: layout(
      `Falha ao publicar em ${accountLabel}`,
      `<p>A publicação em <strong>${accountLabel}</strong> (${platformName}) não foi concluída.</p>
       <p style="background:#fef2f2;border-left:3px solid #dc2626;padding:12px;color:#991b1b">${reason}</p>
       <p>Os outros destinos desta publicação não foram afetados.</p>`,
      url,
      'Ver na fila',
    ),
  };
}

export function tokenExpiredMessage(
  to: string,
  accountLabel: string,
  platformName: string,
  url: string,
): MailMessage {
  return {
    to,
    subject: `Reconecte a conta ${accountLabel}`,
    text: `O acesso à conta ${accountLabel} (${platformName}) expirou. Reconecte em: ${url}`,
    html: layout(
      `Reconecte ${accountLabel}`,
      `<p>O acesso à conta <strong>${accountLabel}</strong> (${platformName}) expirou ou foi revogado.</p>
       <p>Enquanto não for reconectada, as publicações agendadas para ela não sairão.</p>`,
      url,
      'Reconectar conta',
    ),
  };
}

export function approvalPendingMessage(
  to: string,
  postTitle: string,
  requesterName: string,
  url: string,
): MailMessage {
  return {
    to,
    subject: 'Conteúdo aguardando sua aprovação',
    text: `${requesterName} enviou "${postTitle}" para aprovação.\n\nRevisar: ${url}`,
    html: layout(
      'Conteúdo aguardando aprovação',
      `<p><strong>${requesterName}</strong> enviou <strong>${postTitle}</strong> para sua revisão.</p>`,
      url,
      'Revisar conteúdo',
    ),
  };
}
