import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { createTelegramProxyAgent } from '../telegram-proxy';

describe('createTelegramProxyAgent', () => {
  it('returns undefined when proxy is not configured', () => {
    expect(createTelegramProxyAgent()).toBeUndefined();
    expect(createTelegramProxyAgent('  ')).toBeUndefined();
  });

  it('creates an HTTPS tunneling agent for an HTTP proxy', () => {
    expect(createTelegramProxyAgent('http://proxy.example:3128')).toBeInstanceOf(HttpsProxyAgent);
  });

  it('creates a SOCKS agent and accepts proxy-side DNS resolution', () => {
    expect(createTelegramProxyAgent('socks5h://user:password@proxy.example:1080')).toBeInstanceOf(
      SocksProxyAgent,
    );
  });

  it('rejects invalid and unsupported proxy URLs', () => {
    expect(() => createTelegramProxyAgent('not-a-url')).toThrow('valid proxy URL');
    expect(() => createTelegramProxyAgent('ftp://proxy.example')).toThrow('must use http');
  });
});
