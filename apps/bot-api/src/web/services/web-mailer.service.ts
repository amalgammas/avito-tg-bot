import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class WebMailerService {
  private readonly logger = new Logger(WebMailerService.name);

  constructor(private readonly config: ConfigService) {}

  async sendMagicLink(email: string, magicLink: string): Promise<{ mode: 'resend' | 'log'; previewUrl?: string }> {
    return this.sendEmail(email, 'Вход в кабинет поставок', [
      '<p>Нажмите на ссылку для входа в кабинет поставок Ozon.</p>',
      `<p><a href="${magicLink}">Войти</a></p>`,
      '<p>Если вы не запрашивали вход, просто проигнорируйте письмо.</p>',
    ], `Magic link for ${email}: ${magicLink}`, magicLink);
  }

  async sendSupplyCreatedEmail(
    email: string,
    payload: {
      orderId?: number;
      operationId?: string;
      warehouse?: string;
      dropOffName?: string;
      timeslotLabel?: string;
    },
  ): Promise<{ mode: 'resend' | 'log'; previewUrl?: string }> {
    const lines = [
      '<p>Поставка успешно создана.</p>',
      payload.orderId ? `<p><strong>ID поставки:</strong> ${payload.orderId}</p>` : undefined,
      payload.operationId ? `<p><strong>Операция:</strong> ${payload.operationId}</p>` : undefined,
      payload.timeslotLabel ? `<p><strong>Таймслот:</strong> ${payload.timeslotLabel}</p>` : undefined,
      payload.warehouse ? `<p><strong>Склад:</strong> ${payload.warehouse}</p>` : undefined,
      payload.dropOffName ? `<p><strong>Пункт сдачи:</strong> ${payload.dropOffName}</p>` : undefined,
    ].filter((line): line is string => Boolean(line));

    const preview = [
      'Supply created email',
      `email: ${email}`,
      payload.orderId ? `orderId: ${payload.orderId}` : undefined,
      payload.operationId ? `operationId: ${payload.operationId}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');

    return this.sendEmail(email, 'Поставка создана', lines, preview);
  }

  private async sendEmail(
    email: string,
    subject: string,
    htmlLines: string[],
    logPreview: string,
    previewUrl?: string,
  ): Promise<{ mode: 'resend' | 'log'; previewUrl?: string }> {
    const resendApiKey = this.config.get<string>('email.resendApiKey');
    const from = this.config.get<string>('email.from') ?? 'no-reply@example.com';

    if (!resendApiKey) {
      this.logger.log(logPreview);
      return { mode: 'log', previewUrl };
    }

    await axios.post(
      'https://api.resend.com/emails',
      {
        from,
        to: [email],
        subject,
        html: htmlLines.join(''),
      },
      {
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return { mode: 'resend' };
  }
}
