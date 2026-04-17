import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class WebMailerService {
  private readonly logger = new Logger(WebMailerService.name);

  constructor(private readonly config: ConfigService) {}

  async sendMagicLink(email: string, magicLink: string): Promise<{ mode: 'resend' | 'log'; previewUrl?: string }> {
    const resendApiKey = this.config.get<string>('email.resendApiKey');
    const from = this.config.get<string>('email.from') ?? 'no-reply@example.com';

    if (!resendApiKey) {
      this.logger.log(`Magic link for ${email}: ${magicLink}`);
      return { mode: 'log', previewUrl: magicLink };
    }

    await axios.post(
      'https://api.resend.com/emails',
      {
        from,
        to: [email],
        subject: 'Вход в кабинет поставок',
        html: [
          '<p>Нажмите на ссылку для входа в кабинет поставок Ozon.</p>',
          `<p><a href="${magicLink}">Войти</a></p>`,
          '<p>Если вы не запрашивали вход, просто проигнорируйте письмо.</p>',
        ].join(''),
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
