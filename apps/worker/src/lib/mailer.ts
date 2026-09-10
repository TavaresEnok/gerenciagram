import nodemailer, { type Transporter } from 'nodemailer';

export interface MailerConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
}

export interface Mailer {
  send(message: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

export function createMailer(config: MailerConfig): Mailer {
  const transporter: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
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
  };
}
