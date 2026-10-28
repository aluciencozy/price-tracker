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
    if (example.status === 429 || example.responseHeaders?.['Retry-After']) {
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
