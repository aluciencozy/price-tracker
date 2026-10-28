import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { exchanges, products, tracker, user, pushEvent, unavailableProduct, error } from '../docs/api/examples.mjs';

const file = new URL('../docs/api/openapi.json', import.meta.url);
const contract = JSON.parse(readFileSync(file));
const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
addFormats(ajv);
// Keep the published OpenAPI as source; translate only its local reference prefix for Ajv.
const definitions = JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
const validators = new Map(Object.keys(definitions).map((name) => [name, ajv.compile({ $defs: definitions, $ref: `#/$defs/${name}` })]));
const resolve = (value) => value?.$ref ? value.$ref.slice(2).split('/').reduce((current, key) => current[key], contract) : value;
const compiled = new WeakMap();
const validatorFor = (schema) => {
  if (schema.$ref && Object.keys(schema).length === 1) return validators.get(schema.$ref.split('/').at(-1));
  if (!compiled.has(schema)) {
    compiled.set(schema, ajv.compile({ $defs: definitions, ...JSON.parse(JSON.stringify(schema).replaceAll('#/components/schemas/', '#/$defs/')) }));
  }
  return compiled.get(schema);
};
const validate = (schema, value) => {
  const validator = validatorFor(schema);
  assert.ok(validator(value), JSON.stringify({ value, errors: validator.errors }, null, 2));
};
const reject = (name, value) => assert.equal(validators.get(name)(value), false, `${name} incorrectly accepted ${JSON.stringify(value)}`);
const methods = new Set(['get', 'post', 'patch', 'put', 'delete']);
const operations = Object.entries(contract.paths).flatMap(([path, entry]) => Object.entries(entry)
  .filter(([method]) => methods.has(method)).map(([method, operation]) => ({ path, method, operation, entry })));

test('OpenAPI 3.1 document resolves and passes structural validation', async () => {
  const parsed = await SwaggerParser.validate(file.pathname, { resolve: { external: false, http: false } });
  assert.equal(parsed.openapi, '3.1.0');
  assert.equal(new Set(operations.map(({ operation }) => operation.operationId)).size, operations.length);
  assert.equal(operations.length, 29);
  assert.ok(validators.size > 40, 'every model compiles with the 2020-12 validator');
});

test('every object is strict and required keys really exist', () => {
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) assert.ok(value.$ref.startsWith('#/'), 'contract checks must not fetch external references');
    if (value.type === 'object') {
      assert.equal(value.additionalProperties, false);
      for (const key of value.required ?? []) assert.ok(Object.hasOwn(value.properties, key), key);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(contract);
});

test('every route has a complete successful exchange and valid auth/header/parameter shapes', () => {
  for (const { path, method, operation, entry } of operations) {
    const examples = exchanges.filter((example) => example.path === path && example.method === method && example.status < 300);
    assert.ok(examples.length, `${operation.operationId} missing success example`);
    for (const example of examples) {
      const body = resolve(operation.requestBody);
      if (body) validate(body.content['application/json'].schema, example.request);
      else assert.equal(example.request, undefined, `${operation.operationId} is bodyless`);
      const parameters = [...entry.parameters ?? [], ...operation.parameters ?? []].map(resolve);
      for (const parameter of parameters) {
        const source = { path: example.params, query: example.query, header: example.headers }[parameter.in] ?? {};
        const value = source[parameter.name];
        if (parameter.required) assert.notEqual(value, undefined, `${operation.operationId} missing ${parameter.name}`);
        if (value !== undefined) validate(parameter.schema, value);
      }
      const security = operation.security ?? contract.security;
      const hasBearer = Boolean(example.headers.Authorization);
      const hasCookie = Boolean(example.headers.Cookie);
      assert.ok(!(hasBearer && hasCookie));
      assert.ok(security.length === 0 || security.some((alternative) => Object.keys(alternative).every((scheme) => ({
        mobileBearer: hasBearer,
        webSession: Boolean(example.headers.Cookie?.includes('__Host-price_tracker_session=')),
        webCsrf: hasCookie && Boolean(example.headers['X-CSRF-Token']) && Boolean(example.headers.Origin),
      })[scheme])), `${operation.operationId} example does not match its security alternative`);
    }
  }
});

test('all operations declare status-specific infrastructure errors and CSRF origin denial', () => {
  for (const { operation } of operations) {
    const statuses = [[500, 'INTERNAL_ERROR']];
    if (operation.requestBody) statuses.push([413, 'PAYLOAD_TOO_LARGE'], [415, 'UNSUPPORTED_MEDIA_TYPE']);
    for (const [status, code] of statuses) {
      const response = resolve(operation.responses[status]);
      assert.ok(response, `${operation.operationId} missing ${status}`);
      const schema = response.content['application/json'].schema;
      validate(schema, error(code, 'Illustrative failure.'));
      assert.equal(validatorFor(schema)(error('NOT_FOUND', 'Wrong status code.')), false);
      assert.equal(validatorFor(schema)({ ...error(code, 'Failure.'), debug: 'must not leak' }), false);
    }
  }
  const denial = resolve(contract.paths['/api/auth/web/csrf'].get.responses['403']);
  assert.ok(denial, 'CSRF bootstrap must document denied origins');
  validate(denial.content['application/json'].schema, error('ORIGIN_DENIED', 'Origin is not allowed.'));
});

test('JSON request examples include Content-Type and cookie-free CSRF bootstrap establishes context', () => {
  for (const example of exchanges.filter(({ request }) => request !== undefined)) {
    assert.equal(example.headers['Content-Type'], 'application/json', `${example.method} ${example.path}`);
    const operation = contract.paths[example.path][example.method];
    assert.ok(resolve(operation.requestBody).content[example.headers['Content-Type']]);
  }
  const bootstrap = exchanges.find(({ path, status, headers }) => path === '/api/auth/web/csrf' && status === 200 && !headers.Cookie);
  const cookie = bootstrap.responseHeaders?.['Set-Cookie'];
  assert.ok(cookie, 'pre-login bootstrap must set its binding cookie');
  const [binding, ...attributes] = cookie.split('; ');
  const flags = new Set(attributes);
  for (const attribute of ['Path=/', 'Max-Age=1800', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(flags.has(attribute));
  assert.ok(!attributes.some((attribute) => attribute.startsWith('Domain=')));
  for (const account of exchanges.filter(({ path, status, headers }) => path.startsWith('/api/auth/web/') && status < 300 && headers.Cookie?.startsWith('__Host-price_tracker_prelogin='))) {
    assert.equal(account.headers.Cookie, binding);
    assert.equal(account.headers['X-CSRF-Token'], bootstrap.response.csrfToken);
  }
});

test('each web account form has pre-login and session-bound CSRF examples', () => {
  const bootstrap = exchanges.find(({ path, status, headers }) => path === '/api/auth/web/csrf' && status === 200 && headers.Cookie);
  assert.ok(bootstrap, 'existing sessions need a bootstrap example');
  const accountForms = operations.filter(({ path, operation }) => path.startsWith('/api/auth/web/') && operation.requestBody);
  assert.equal(accountForms.length, 6);
  for (const { path } of accountForms) {
    const examples = exchanges.filter((example) => example.path === path && example.status < 300);
    assert.ok(examples.some(({ headers }) => headers.Cookie.startsWith('__Host-price_tracker_prelogin=')), `${path} missing pre-login example`);
    const currentSession = examples.find(({ headers }) => headers.Cookie === bootstrap.headers.Cookie);
    assert.ok(currentSession, `${path} missing current-session example`);
    assert.equal(currentSession.headers['X-CSRF-Token'], bootstrap.response.csrfToken);
  }
});

test('successful running polls accept Retry-After without an error body', () => {
  const poll = exchanges.find(({ path, status, response }) => path === '/api/admin/price-checks/{id}' && status === 200 && response.status === 'running');
  assert.ok(poll, 'running response regression fixture is required');
  const response = contract.paths[poll.path].get.responses['200'];
  validate(response.content['application/json'].schema, poll.response);
  assert.equal(poll.response.error, undefined);
  const schema = response.headers['Retry-After'].schema;
  validate(schema, poll.responseHeaders['Retry-After']);
  assert.equal(validatorFor(schema)(4), false);
  assert.equal(validatorFor(schema)('5'), false);
});

test('price-check states require consistent timestamps and successful/partial counts', () => {
  const queued = exchanges.find(({ path, status }) => path === '/api/admin/price-checks' && status === 202).response;
  const running = { ...queued, status: 'running', startedAt: queued.createdAt };
  const terminal = { ...running, finishedAt: '2026-10-28T12:01:00Z' };
  const succeeded = { ...terminal, status: 'succeeded' };
  const partial = { ...terminal, status: 'partial', counts: { total: 2, succeeded: 1, failed: 1, skipped: 0 } };
  const failed = { ...terminal, status: 'failed', counts: { total: 2, succeeded: 0, failed: 2, skipped: 0 } };
  for (const value of [queued, running, succeeded, partial, failed]) validate({ $ref: '#/components/schemas/PriceCheck' }, value);
  reject('PriceCheck', { ...queued, startedAt: queued.createdAt });
  reject('PriceCheck', { ...queued, finishedAt: terminal.finishedAt });
  reject('PriceCheck', { ...running, startedAt: null });
  reject('PriceCheck', { ...running, finishedAt: terminal.finishedAt });
  for (const value of [succeeded, partial, failed]) {
    reject('PriceCheck', { ...value, startedAt: null });
    reject('PriceCheck', { ...value, finishedAt: null });
  }
  reject('PriceCheck', { ...succeeded, counts: { total: 2, succeeded: 0, failed: 2, skipped: 0 } });
  reject('PriceCheck', { ...partial, counts: { total: 1, succeeded: 0, failed: 1, skipped: 0 } });
  reject('PriceCheck', { ...partial, counts: { total: 1, succeeded: 1, failed: 0, skipped: 0 } });
});

test('all success and error response examples match their endpoint status schemas', () => {
  for (const example of exchanges) {
    const operation = contract.paths[example.path][example.method];
    const response = resolve(operation.responses[example.status]);
    assert.ok(response, `${example.method} ${example.path} undocumented status ${example.status}`);
    if (response.content) validate(response.content['application/json'].schema, example.response);
    else assert.equal(example.response, undefined, '204 must not serialize null/{}');
    const body = resolve(operation.requestBody);
    if (body && example.request !== undefined) {
      if (example.invalidRequest) {
        const name = body.content['application/json'].schema.$ref.split('/').at(-1);
        reject(name, example.request);
      } else validate(body.content['application/json'].schema, example.request);
    }
    for (const [name, header] of Object.entries(response.headers ?? {})) {
      const value = example.responseHeaders?.[name];
      if (header.required) assert.notEqual(value, undefined);
      if (value !== undefined) validate(header.schema, value);
    }
    if (example.status >= 400 && (example.status === 429 || example.responseHeaders?.['Retry-After'] !== undefined)) {
      assert.equal(example.response.error.retryAfterSeconds, example.responseHeaders['Retry-After']);
    }
  }
});

test('money accepts zero and max-safe cents, rejects floats, strings, negatives and overflow', () => {
  for (const amountMinor of [0, 999, Number.MAX_SAFE_INTEGER]) validate({ $ref: '#/components/schemas/Money' }, { amountMinor, currency: 'USD' });
  for (const amountMinor of [-1, 0.01, '999', null, Number.MAX_SAFE_INTEGER + 1]) reject('Money', { amountMinor, currency: 'USD' });
  reject('Money', { amountMinor: 100, currency: 'EUR' });
  reject('Money', { amountMinor: 100, currency: 'USD', amount: 1 });
});

test('client writes cannot spoof ownership, provider identity, price or history', () => {
  const body = exchanges.find((example) => example.path === '/api/tracked-items' && example.method === 'post').request;
  for (const key of ['userId', 'ownerId', 'productId', 'identity', 'currentPrice', 'history', 'createdAt']) {
    reject('CreateTrackedItemRequest', { ...body, [key]: 'forged' });
    reject('UpdateTrackedItemRequest', { enabled: true, [key]: 'forged' });
  }
  reject('UpdateTrackedItemRequest', {});
  reject('UpdateTrackedItemRequest', { alerts: { email: true } });
  reject('UpdateTrackedItemRequest', { enabled: 'false' });
  reject('PreviewRequest', { url: products[0].canonicalSteamUrl, providerGameId: '36' });
  reject('DeviceRequest', { installationId: 'b36d3290-4086-4a55-98d5-783cb9f24031', platform: 'android', pushToken: 'example', sessionId: 'forged' });
  reject('EmptyRequest', { productId: products[0].id });
});

test('product examples keep real proof identity separate from dated observations and absent data', () => {
  for (const product of [...products, unavailableProduct]) validate({ $ref: '#/components/schemas/Product' }, product);
  assert.deepEqual(products.map(({ steamAppId, identity }) => [steamAppId, identity.providerGameId]), [['620', '36'], ['220', '59']]);
  for (const product of products) {
    assert.equal(product.canonicalSteamUrl, `https://store.steampowered.com/app/${product.steamAppId}/`);
    assert.equal(product.purchaseUrl, `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(product.dealId)}`);
    assert.equal(product.freshness, 'stale');
    assert.equal(Date.parse(product.staleAt) - Date.parse(product.observedAt), 86400000);
  }
  reject('Product', { ...products[0], identity: { ...products[0].identity, storeId: '7' } });
  reject('Product', { ...products[0], identity: { ...products[0].identity, providerGameId: 36 } });
  reject('Product', { ...products[0], steamAppId: 620 });
  reject('Product', { ...products[0], canonicalSteamUrl: 'https://store.steampowered.com.evil.test/app/620/' });
  for (const purchaseUrl of ['https://evil.test/redirect?dealID=x', 'https://www.cheapshark.com/redirect?dealID=x&url=evil', 'javascript:alert(1)', products[0].canonicalSteamUrl]) {
    reject('Product', { ...products[0], purchaseUrl });
  }
  reject('Product', { ...products[0], observedAt: null });
  reject('Product', { ...unavailableProduct, currentPrice: { amountMinor: 0, currency: 'USD' } });
  reject('Product', { ...products[0], freshness: 'fresh', lastError: { code: 'PROVIDER_UNAVAILABLE', message: 'failed', occurredAt: products[0].observedAt, retryAt: null } });
  const missing = { ...products[0] };
  delete missing.retailPrice;
  reject('Product', missing);
  validate({ $ref: '#/components/schemas/Product' }, { ...products[0], currentPrice: { amountMinor: 0, currency: 'USD' } });
  validate({ $ref: '#/components/schemas/TrackedItem' }, tracker);
});

test('pagination, dates, account and errors have bounded, strict shapes', () => {
  reject('Page', { limit: 101, nextCursor: null });
  reject('Page', { limit: 20 });
  reject('Page', { limit: 20, nextCursor: '' });
  reject('HistoryWindow', { from: 'yesterday', to: 'tomorrow' });
  reject('HistoryWindow', { from: '2026-10-28T12:00:00+02:00', to: '2026-10-29T12:00:00Z' });
  validate({ $ref: '#/components/schemas/User' }, user);
  reject('User', { ...user, emailVerified: false });
  reject('User', { ...user, passwordHash: 'secret' });
  const webLogin = exchanges.find((example) => example.path === '/api/auth/web/login').response;
  reject('WebLogin', { ...webLogin, accessToken: 'must-not-leak' });
  reject('RegisterRequest', { email: 'bad-email', password: 'long-enough-password' });
  reject('RegisterRequest', { email: user.email, password: 'short' });
  reject('ErrorEnvelope', { error: { code: 'NOT_FOUND', message: 'missing' } });
  reject('ErrorEnvelope', { ...error('NOT_FOUND', 'Missing'), debug: 'stack' });
  reject('ErrorEnvelope', error('NOT_FOUND', 'Missing', [], -1));
  const unauthorized = contract.components.responses.Unauthorized.content['application/json'].schema;
  assert.equal(validatorFor(unauthorized)(error('VALIDATION_ERROR', 'Wrong status code')), false);
  const rateLimited = contract.components.responses.RateLimited.content['application/json'].schema;
  assert.equal(validatorFor(rateLimited)(error('RATE_LIMITED', 'Wait', [], null)), false);
});

test('push schema is string-only, session-addressed and strict', () => {
  validate({ $ref: '#/components/schemas/PushEvent' }, pushEvent);
  assert.ok(Object.values(pushEvent).every((value) => typeof value === 'string'));
  reject('PushEvent', { ...pushEvent, schemaVersion: 1 });
  reject('PushEvent', { ...pushEvent, schemaVersion: '2' });
  reject('PushEvent', { ...pushEvent, url: 'https://evil.test' });
  const missing = { ...pushEvent };
  delete missing.recipientSessionId;
  reject('PushEvent', missing);
});

test('auth alternatives and admin/device boundaries are explicit in the contract', () => {
  for (const { path, method, operation } of operations) {
    const security = operation.security ?? contract.security;
    if (path.startsWith('/api/devices')) assert.deepEqual(security, [{ mobileBearer: [] }]);
    if (path.includes('/web/') && method === 'post') {
      assert.ok(security.every((alternative) => Object.hasOwn(alternative, 'webCsrf')));
      assert.ok(operation.parameters.some((parameter) => resolve(parameter).name === 'Origin' && resolve(parameter).required));
    }
    if (!path.includes('/auth/') && !path.startsWith('/api/devices') && method !== 'get') {
      assert.deepEqual(security, [{ webSession: [], webCsrf: [] }, { mobileBearer: [] }]);
    }
    if (path.startsWith('/api/admin/')) assert.ok(operation.responses['403']);
  }
  assert.equal(contract.paths['/api/products/{id}/history'], undefined);
  assert.equal(contract.paths['/api/price-checks'], undefined);
});
