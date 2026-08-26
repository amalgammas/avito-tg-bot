import type { Agent } from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const HTTP_PROXY_PROTOCOLS = new Set(['http:', 'https:']);
const SOCKS_PROXY_PROTOCOLS = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

export function createTelegramProxyAgent(proxyUrl?: string): Agent | undefined {
  const value = proxyUrl?.trim();
  if (!value) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('TELEGRAM_PROXY_URL must be a valid proxy URL');
  }

  if (HTTP_PROXY_PROTOCOLS.has(parsed.protocol)) {
    return new HttpsProxyAgent(parsed, { keepAlive: true });
  }

  if (SOCKS_PROXY_PROTOCOLS.has(parsed.protocol)) {
    return new SocksProxyAgent(parsed, { keepAlive: true });
  }

  throw new Error(
    'TELEGRAM_PROXY_URL must use http, https, socks, socks4, socks4a, socks5, or socks5h protocol',
  );
}
