import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyVmRelease } from './verify-vm-release.mjs';

const origin = 'https://demo.example';
const release = `${'a'.repeat(40)}-123-1`;
function fixture(overrides = {}) {
  return async (url, options) => {
    assert.equal(url.origin, origin);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const path = url.pathname;
    if (overrides[path]) return overrides[path]();
    if (path === '/' || path === '/watchlist') return new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } });
    if (path === '/deployment.json') return Response.json({ release });
    return Response.json({ status: path.endsWith('/ready') ? 'ready' : 'ok', database: 'connected' });
  };
}
test('accepts only the expected HTTPS release and healthy API/database', async () => {
  await verifyVmRelease(origin, release, fixture());
});
test('fails a stale release even when the website responds successfully', async () => {
  await assert.rejects(verifyVmRelease(origin, release, fixture({
    '/deployment.json': () => Response.json({ release: 'older' }),
  })));
});
test('fails disconnected readiness even with HTTP 200', async () => {
  await assert.rejects(verifyVmRelease(origin, release, fixture({
    '/api/ready': () => Response.json({ status: 'ready', database: 'disconnected' }),
  })));
});
test('fails frontend fallback masquerading as an API response', async () => {
  await assert.rejects(verifyVmRelease(origin, release, fixture({
    '/api/health': () => new Response('<div id="root"></div>'),
  })));
});
test('fails an unavailable direct frontend route', async () => {
  await assert.rejects(verifyVmRelease(origin, release, fixture({
    '/watchlist': () => new Response('Not found', { status: 404 }),
  })));
});
test('rejects invalid destinations and release IDs before making a request', async () => {
  const forbidden = () => { assert.fail('No network request expected'); };
  for (const value of ['http://demo.example', 'https://user:secret@demo.example', `${origin}/api`, `${origin}?token=x`]) {
    await assert.rejects(verifyVmRelease(value, release, forbidden));
  }
  await assert.rejects(verifyVmRelease(origin, '../../other', forbidden));
});
