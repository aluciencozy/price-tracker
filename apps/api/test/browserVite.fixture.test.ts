import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, resolveConfig } from 'vite';
import request from 'supertest';
import { assertFixtureWebEnvironment } from './fixtures/browserVite.config.js';

const configFile = fileURLToPath(new URL('./fixtures/browserVite.config.ts', import.meta.url));
const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const env = { BROWSER_TEST_DISPOSABLE: '1', VITE_DATA_SOURCE: 'api', VITE_API_BASE_URL: '', API_PROXY_TARGET: 'http://127.0.0.1:4016' };

afterEach(() => vi.unstubAllEnvs());

describe('guarded browser fixture disclosure', () => {
  it('rejects missing opt-in and unsafe API configuration', () => {
    expect(() => assertFixtureWebEnvironment(env)).not.toThrow();
    for (const change of [{ BROWSER_TEST_DISPOSABLE: undefined }, { VITE_DATA_SOURCE: 'sample' },
      { VITE_API_BASE_URL: 'https://example.com' }, { API_PROXY_TARGET: 'http://localhost:4016' },
      { API_PROXY_TARGET: 'http://127.0.0.1:4000' }]) {
      expect(() => assertFixtureWebEnvironment({ ...env, ...change })).toThrow();
    }
  });
  it('refuses unguarded, build, and altered host, port or proxy configurations', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const config = { configFile, logLevel: 'silent' as const };
    const resolved = await resolveConfig(config, 'serve', 'development');
    expect(resolved.server).toMatchObject({ host: '127.0.0.1', port: 5176, strictPort: true, proxy: { '/api': { target: env.API_PROXY_TARGET } } });
    for (const server of [{ host: '0.0.0.0' }, { port: 5177 }, { strictPort: false }, { proxy: { '/api': { target: 'http://example.com' } } }]) {
      await expect(resolveConfig({ ...config, server }, 'serve', 'development')).rejects.toThrow();
    }
    await expect(resolveConfig(config, 'build', 'production')).rejects.toThrow();
    vi.stubEnv('BROWSER_TEST_DISPOSABLE', '0');
    await expect(resolveConfig(config, 'serve', 'development')).rejects.toThrow();
  });
  it('injects a static, non-dismissible disclosure outside React on root and direct routes', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const server = await createServer({ configFile, logLevel: 'silent' });
    try {
      for (const route of ['/', '/watchlist/fixture-id']) {
        const result = await server.transformIndexHtml(route, html);
        expect(result).toContain('LOCAL QA ONLY — All prices and history are synthetic, not recorded Steam prices. No real emails or alerts are sent.');
        expect(result).toContain('aria-label="Local QA fixture disclosure"');
        expect(result.indexOf('id="local-qa-disclosure"')).toBeLessThan(result.indexOf('id="root"'));
        expect(result).not.toContain('<button');
        expect(result).not.toContain('fixture-id');
      }
      const mailbox = await request(server.middlewares).get('/api/__fixture/mailbox').set('Accept', 'text/html').expect(200);
      expect(mailbox.text).toContain('All prices and history are synthetic');
      expect(mailbox.text).toContain("output.textContent = JSON.stringify(await response.json(), null, 2)");
      expect(mailbox.headers['cache-control']).toBe('no-store');
    } finally {
      await server.close();
    }
  });
});
