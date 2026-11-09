/** Separate, local-only browser acceptance server; never used by the web build. */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

const fixtureOrigin = 'http://127.0.0.1:4016';

export function assertFixtureWebEnvironment(env: NodeJS.ProcessEnv) {
  if (env.BROWSER_TEST_DISPOSABLE !== '1' || env.VITE_DATA_SOURCE !== 'api' ||
      env.VITE_API_BASE_URL !== '' || env.API_PROXY_TARGET !== fixtureOrigin) {
    throw new Error('Browser fixture requires disposable opt-in, API mode, same-origin base and the exact loopback proxy.');
  }
}

export function fixtureDisclosure(): Plugin {
  return {
    name: 'local-browser-fixture-disclosure',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.method !== 'GET' || request.url !== '/api/__fixture/mailbox' ||
            !request.headers.accept?.includes('text/html')) return next();
        const html = await server.transformIndexHtml('/api/__fixture/mailbox', `<!doctype html>
          <html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local QA mailbox</title></head>
          <body><main><h1>Local QA mailbox</h1><p>Fixture messages only. Do not share tokens.</p><pre id="mailbox">Loading…</pre></main>
          <script> (async () => {
            const output = document.getElementById('mailbox');
            try {
              const response = await fetch('/api/__fixture/mailbox', { headers: { Accept: 'application/json' }, cache: 'no-store' });
              if (!response.ok) throw new Error('Unavailable');
              output.textContent = JSON.stringify(await response.json(), null, 2);
            } catch { output.textContent = 'Fixture mailbox unavailable.'; }
          })(); </script></body></html>`);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(html);
      });
    },
    transformIndexHtml() {
      // Static content only: never interpolate environment values or user input.
      return [
        { tag: 'style', attrs: { 'data-local-qa-disclosure': '' }, children: `
          #local-qa-disclosure { position: sticky; top: 0; z-index: 1000; box-sizing: border-box;
            padding: 6px 12px; background: #3b2100; color: #fff8dc; border-bottom: 2px solid #facc15;
            font: 600 14px/1.35 system-ui, sans-serif; text-align: center; overflow-wrap: anywhere; }
          html { scroll-padding-top: 5rem; }
          #mailbox { white-space: pre-wrap; overflow-wrap: anywhere; }
        `, injectTo: 'head' },
        { tag: 'aside', attrs: { id: 'local-qa-disclosure', 'aria-label': 'Local QA fixture disclosure' },
          children: 'LOCAL QA ONLY — All prices and history are synthetic, not recorded Steam prices. No real emails or alerts are sent.', injectTo: 'body-prepend' },
      ];
    },
  };
}

export default defineConfig(({ command, mode }) => {
  assertFixtureWebEnvironment(process.env);
  if (command !== 'serve' || mode !== 'development') throw new Error('Browser fixture is a development server only.');
  return {
    root: fileURLToPath(new URL('../../../web/', import.meta.url)),
    plugins: [react(), tailwindcss(), fixtureDisclosure(), {
      name: 'local-browser-fixture-server-guard',
      configResolved(config) {
        const proxy = config.server.proxy?.['/api'];
        if (config.server.host !== '127.0.0.1' || config.server.port !== 5176 || !config.server.strictPort ||
            !proxy || typeof proxy === 'string' || proxy.target !== fixtureOrigin || config.server.https) {
          throw new Error('Browser fixture requires exact loopback host, ports and proxy.');
        }
      },
    }],
    resolve: { alias: { '@': fileURLToPath(new URL('../../../web/src/', import.meta.url)) } },
    server: { host: '127.0.0.1', port: 5176, strictPort: true, proxy: { '/api': { target: fixtureOrigin } } },
  };
});
