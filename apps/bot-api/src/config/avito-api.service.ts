import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosRequestConfig, AxiosResponse } from 'axios';

@Injectable()
export class AvitoApiService {
  private readonly logger = new Logger(AvitoApiService.name);
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenRequest?: Promise<string>;

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const token = await this.getAccessToken();
    const baseUrl = this.configService.get<string>('avito.apiBaseUrl') ?? 'https://api.avito.ru';
    const url = this.resolveUrl(baseUrl, config.url);

    return this.http.axiosRef.request<T>({
      ...config,
      url,
      headers: {
        ...(config.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
  }

  private resolveUrl(baseUrl: string, url?: string): string | undefined {
    if (!url) {
      return url;
    }

    if (/^https?:\/\//i.test(url)) {
      return url;
    }

    const normalizedBase = baseUrl.replace(/\/$/, '');
    const normalizedPath = url.startsWith('/') ? url : `/${url}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();

    if (this.accessToken && now < this.tokenExpiresAt) {
      return this.accessToken;
    }

    if (!this.tokenRequest) {
      this.tokenRequest = this.fetchAccessToken()
        .catch((error) => {
          this.logger.error('Failed to obtain Avito access token', error);
          throw error;
        })
        .finally(() => {
          this.tokenRequest = undefined;
        });
    }

    return this.tokenRequest;
  }

  private async fetchAccessToken(): Promise<string> {
    const clientId = this.configService.get<string>('avito.clientId');
    const clientSecret = this.configService.get<string>('avito.clientSecret');
    const authUrl = this.configService.get<string>('avito.authUrl') ?? 'https://api.avito.ru/token';

    if (!clientId || !clientSecret) {
      throw new Error('AVITO_CLIENT_ID and AVITO_CLIENT_SECRET must be configured');
    }

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await this.http.axiosRef.post<{
      access_token: string;
      token_type: string;
      expires_in: number;
    }>(authUrl, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const { access_token: accessToken, expires_in: expiresIn } = response.data;

    if (!accessToken) {
      throw new Error('Avito token response did not include access_token');
    }

    const now = Date.now();
    const expiresInMs = Math.max(0, (expiresIn ?? 0) * 1000);
    // Refresh the token slightly earlier than the real expiration.
    this.tokenExpiresAt = now + Math.max(0, expiresInMs - 30_000);
    this.accessToken = accessToken;

    this.logger.debug(`Obtained Avito access token, valid for ${Math.round(expiresInMs / 1000)}s`);

    return accessToken;
  }
}
