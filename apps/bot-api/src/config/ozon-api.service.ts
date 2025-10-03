import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
  isAxiosError,
} from 'axios';

export interface OzonCredentials {
  clientId: string;
  apiKey: string;
}

@Injectable()
export class OzonApiService {
  private readonly logger = new Logger(OzonApiService.name);

  private readonly baseUrl: string;
  private readonly httpTimeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly defaultCredentials?: OzonCredentials;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl =
      this.config.get<string>('ozon.apiBaseUrl') ??
      this.config.get<string>('OZON_API_BASE_URL') ??
      'https://api-seller.ozon.ru';

    this.httpTimeoutMs = Number(this.config.get<string>('HTTP_TIMEOUT_MS') ?? '10000');
    this.retryAttempts = Number(this.config.get<string>('HTTP_RETRY_ATTEMPTS') ?? '3');
    this.retryBaseDelayMs = Number(this.config.get<string>('HTTP_RETRY_BASE_MS') ?? '200');

    const clientId = this.config.get<string>('ozon.clientId') ?? this.config.get<string>('OZON_CLIENT_ID');
    const apiKey = this.config.get<string>('ozon.apiKey') ?? this.config.get<string>('OZON_API_KEY');

    if (clientId && apiKey) {
      this.defaultCredentials = { clientId, apiKey };
    }
  }

  /**
   * Универсальный запрос к Ozon API.
   * credentials можно передать явно, иначе используются значения из конфигурации.
   */
  async request<T = unknown>(
    config: AxiosRequestConfig,
    credentials?: OzonCredentials,
  ): Promise<AxiosResponse<T>> {
    const creds = credentials ?? this.defaultCredentials;
    if (!creds) {
      throw new Error('Ozon credentials are not configured');
    }

    const url = this.resolveUrl(this.baseUrl, config.url);
    const method = (config.method ?? 'GET').toUpperCase();
    const requestId = `${method} ${url ?? '<relative>'}`;

    const finalConfig: AxiosRequestConfig = {
      timeout: this.httpTimeoutMs,
      ...config,
      url,
      headers: {
        ...(config.headers ?? {}),
        'Client-Id': creds.clientId,
        'Api-Key': creds.apiKey,
      },
    };

    let attempt = 0;
    while (true) {
      const startedAt = Date.now();
      try {
        this.logger.debug(
          `→ [${requestId}] attempt ${attempt + 1}/${this.retryAttempts} headers=${this.describeHeaders(
            finalConfig.headers,
          )}`,
        );

        const response = await this.http.axiosRef.request<T>(finalConfig);
        const duration = Date.now() - startedAt;
        this.logger.debug(`← [${requestId}] ${response.status} ${response.statusText} in ${duration}ms`);
        return response;
      } catch (err) {
        const duration = Date.now() - startedAt;
        const errorSummary = this.describeError(err);
        this.logger.error(
          `× [${requestId}] failed in ${duration}ms: ${errorSummary}${this.describeErrorPayload(err)}`,
        );

        const shouldRetry = this.shouldRetry(err) && attempt < this.retryAttempts - 1;
        if (!shouldRetry) throw err;

        attempt++;
        const delay = this.retryBaseDelayMs * 2 ** (attempt - 1);
        this.logger.warn(`↻ [${requestId}] retry ${attempt + 1}/${this.retryAttempts} in ~${delay}ms`);
        await this.sleep(delay);
      }
    }
  }

  async post<T = unknown>(url: string, data?: any, cfg?: AxiosRequestConfig, credentials?: OzonCredentials) {
    const headers =
      data && typeof data === 'object' && !(data instanceof URLSearchParams)
        ? { 'Content-Type': 'application/json', ...(cfg?.headers ?? {}) }
        : cfg?.headers;
    return this.request<T>({ method: 'POST', url, data, ...(cfg ?? {}), headers }, credentials);
  }

  async get<T = unknown>(url: string, cfg?: AxiosRequestConfig, credentials?: OzonCredentials) {
    return this.request<T>({ method: 'GET', url, ...(cfg ?? {}) }, credentials);
  }

  /** Проверка ключей: запрашиваем информацию о продавце. */
  async validateCredentials(credentials: OzonCredentials): Promise<{ account: unknown }> {
    const response = await this.post('/v1/seller/info', {}, undefined, credentials);
    return { account: response.data };
  }

  async getSellerInfo(credentials?: OzonCredentials): Promise<unknown> {
    const response = await this.post('/v1/seller/info', {}, undefined, credentials);
    return response.data;
  }

  async listWarehouses(credentials?: OzonCredentials): Promise<unknown> {
    const response = await this.post('/v1/warehouse/fbo/list', {}, undefined, credentials);
    return response.data;
  }

  private resolveUrl(baseUrl: string, url?: string): string | undefined {
    if (!url) return url;
    if (/^https?:\/\//i.test(url)) return url;

    const normalizedBase = baseUrl.replace(/\/$/, '');
    const normalizedPath = url.startsWith('/') ? url : `/${url}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  private shouldRetry(err: unknown): boolean {
    if (!isAxiosError(err)) return false;
    const status = err.response?.status ?? 0;
    return status === 429 || (status >= 500 && status <= 599) || this.isTimeout(err);
  }

  private isTimeout(err: AxiosError): boolean {
    return err.code === 'ECONNABORTED';
  }

  private describeHeaders(headers: AxiosRequestConfig['headers']): string {
    if (!headers) return '{}';
    try {
      const normalized = Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
        if (typeof value === 'undefined') return acc;
        if (key.toLowerCase() === 'api-key') {
          acc[key] = this.maskApiKey(String(value));
        } else if (key.toLowerCase() === 'client-id') {
          acc[key] = this.maskClientId(String(value));
        } else {
          acc[key] = Array.isArray(value) ? value.join(',') : String(value);
        }
        return acc;
      }, {});
      return JSON.stringify(normalized);
    } catch (error) {
      return '<unable to stringify headers>';
    }
  }

  private describeError(err: unknown): string {
    if (isAxiosError(err)) {
      const s = err.response?.status;
      return `AxiosError ${s ?? ''} ${err.message}`;
    }
    return String(err);
  }

  private describeErrorPayload(err: unknown): string {
    if (isAxiosError(err) && err.response?.data) {
      try {
        return ` payload=${JSON.stringify(err.response.data)}`;
      } catch (error) {
        return ' payload=<unserializable>';
      }
    }
    return '';
  }

  private maskClientId(clientId: string): string {
    if (clientId.length <= 4) {
      return `${clientId[0] ?? '*'}***`;
    }
    return `${clientId.slice(0, 3)}***${clientId.slice(-2)}`;
  }

  private maskApiKey(apiKey: string): string {
    if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
    return `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`;
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
