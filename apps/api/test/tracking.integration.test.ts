import express, { type RequestHandler } from 'express';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createDatabaseIndexes } from '../src/models/index.js';
import { AuthLimitModel } from '../src/models/account.js';
import { ProductModel } from '../src/models/product.js';
import { NotificationDeliveryModel, PriceHistoryModel, TrackedItemModel } from '../src/models/tracking.js';
import { ProductPreviewModel, TrackingIdempotencyModel } from '../src/models/trackingApi.js';
import { createProductPreviewService } from '../src/productPreviews.js';
import { createTrackingRouter } from '../src/trackingRouter.js';
import { cheapSharkPurchaseUrl } from '../src/cheapshark.js';

const uri = process.env.TEST_MONGODB_URI;
const signingSecret = 'tracking-integration-cursor-secret-32-bytes-minimum';

describe('tracking auth boundary', () => {
  it('fails closed if injected middleware does not provide a verified principal', async () => {
    const app = express();
    const noPrincipal: RequestHandler = (_request, _response, next) => next();
    app.use('/api', createTrackingRouter(noPrincipal, signingSecret, {
      createPreview: createProductPreviewService({ resolveProduct: async () => { throw new Error('not called'); } }),
    }));
    const response = await request(app).get('/api/tracked-items').expect(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error).toMatchObject({ code: 'AUTH_REQUIRED', resourceId: null, fields: [] });
  });
});

describe.skipIf(!uri)('owned tracking API with disposable MongoDB', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  let principalUserId = String(new Types.ObjectId());
  let portalId: string;
  let previewResolverCalls = 0;
  let previewResolverFailure: Error | null = null;
  let previewResolverGate: (() => Promise<void>) | null = null;
  const now = new Date('2026-11-06T12:00:00.000Z');
  const contract = JSON.parse(readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'));
  const definitions = JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
  const ajv = new Ajv2020({ strict: true, strictTypes: false });
  addFormats.default(ajv);
  const validPreview = ajv.compile({ $defs: definitions, $ref: '#/$defs/ProductPreview' });
  const validTrackedItem = ajv.compile({ $defs: definitions, $ref: '#/$defs/TrackedItem' });
  const validTrackedItemList = ajv.compile({ $defs: definitions, $ref: '#/$defs/TrackedItemList' });
  const validError = ajv.compile({ $defs: definitions, $ref: '#/$defs/ErrorEnvelope' });

  const auth: RequestHandler = (_request, response, next) => {
    response.locals.principal = {
      userId: principalUserId,
      sessionId: 'test-session-only',
      transport: 'mobile',
      role: 'user',
    };
    next();
  };

  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', createTrackingRouter(auth, signingSecret, {
    now: () => new Date(now),
    createPreview: createProductPreviewService({
      now: () => new Date(now),
      resolveProduct: async productId => {
        previewResolverCalls += 1;
        if (previewResolverFailure) throw previewResolverFailure;
        if (previewResolverGate) await previewResolverGate();
        return ProductModel.findById(productId).orFail().lean().exec();
      },
    }),
  }));

  async function addProduct({ appId, gameId, title }: { appId: string; gameId: string; title: string }) {
    const at = new Date(now.getTime() - 5_000);
    const product = await ProductModel.create({
      provider: 'cheapshark', providerGameId: gameId, steamAppId: appId,
      storeId: '1', market: 'US', currency: 'USD',
      canonicalSteamUrl: `https://store.steampowered.com/app/${appId}/`,
      title, dealId: `fixture-${gameId}`, purchaseUrl: cheapSharkPurchaseUrl(`fixture-${gameId}`),
      currentPriceMinor: 999, retailPriceMinor: 1999,
      lastSuccessfulCheckAt: at, providerChangedAt: null,
      nextCheckAt: new Date(at.getTime() + 86_400_000), lastAttemptAt: at,
      lastError: null, consecutiveFailures: 0,
    });
    return String(product._id);
  }

  function preview(url = 'https://store.steampowered.com/app/620/') {
    return request(app).post('/api/product-previews').send({ url });
  }

  function createFromPreview(previewId: string, key = randomUUID(), target = 500) {
    return request(app).post('/api/tracked-items')
      .set('Idempotency-Key', key)
      .send({ previewId, targetPrice: { amountMinor: target, currency: 'USD' }, enabled: true, alerts: { email: true, push: false } });
  }

  beforeAll(async () => {
    if (!dbName.startsWith('price_tracker_test_')) throw new Error('Refusing a non-disposable test database name.');
    await mongoose.connect(uri!, { dbName, serverSelectionTimeoutMS: 5000, autoIndex: false });
    if (mongoose.connection.name !== dbName) throw new Error('Refusing to use an unexpected MongoDB database.');
    await createDatabaseIndexes();
  }, 30_000);

  beforeEach(async () => {
    await Promise.all([
      AuthLimitModel.deleteMany({}), ProductPreviewModel.deleteMany({}), TrackingIdempotencyModel.deleteMany({}),
      NotificationDeliveryModel.deleteMany({}), PriceHistoryModel.deleteMany({}), TrackedItemModel.deleteMany({}), ProductModel.deleteMany({}),
    ]);
    principalUserId = String(new Types.ObjectId());
    previewResolverCalls = 0;
    previewResolverFailure = null;
    previewResolverGate = null;
    portalId = await addProduct({ appId: '620', gameId: '36', title: 'Portal 2' });
    await addProduct({ appId: '220', gameId: '59', title: 'Half-Life 2' });
  });

  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('previews only locally allowlisted supported Steam URLs and stores an owned, expiring snapshot', async () => {
    const bad = await preview('https://attacker.example/app/620').expect(422);
    expect(bad.body.error.code).toBe('UNSUPPORTED_URL');
    const unknown = await preview('https://store.steampowered.com/app/999/').expect(422);
    expect(unknown.body.error.code).toBe('UNSUPPORTED_PRODUCT');
    const malformed = await request(app).post('/api/product-previews').send({ url: 'https://store.steampowered.com/app/620/', extra: true }).expect(422);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');

    const response = await preview().expect(201);
    expect(response.body.product).toMatchObject({
      steamAppId: '620', title: 'Portal 2', storeName: 'Steam',
      currentPrice: { amountMinor: 999, currency: 'USD' },
      source: { name: 'CheapShark' }, freshness: 'fresh',
      purchaseUrl: 'https://www.cheapshark.com/redirect?dealID=fixture-36',
    });
    expect(response.body.expiresAt).toBe(new Date(now.getTime() + 600_000).toISOString());
    expect(await ProductPreviewModel.countDocuments({ userId: principalUserId })).toBe(1);
    expect(previewResolverCalls).toBe(1);
    expect(await PriceHistoryModel.countDocuments()).toBe(0);
    expect(await TrackedItemModel.countDocuments()).toBe(0);
    expect(await NotificationDeliveryModel.countDocuments()).toBe(0);
  });

  it('labels a retained quote stale after a failed preview refresh without creating history', async () => {
    previewResolverFailure = new Error('offline fixture failure');
    const response = await preview().expect(201);
    expect(response.body.product).toMatchObject({
      currentPrice: { amountMinor: 999, currency: 'USD' },
      freshness: 'stale',
      lastError: { code: 'PROVIDER_UNAVAILABLE' },
    });
    expect(await PriceHistoryModel.countDocuments()).toBe(0);
  });

  it('limits each user to two in-flight previews', async () => {
    let entered = 0;
    let unblock!: () => void;
    let twoEntered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const enteredTwice = new Promise<void>(resolve => { twoEntered = resolve; });
    previewResolverGate = async () => {
      entered += 1;
      if (entered === 2) twoEntered();
      await gate;
    };

    const first = preview().expect(201).then(response => response);
    const second = preview().expect(201).then(response => response);
    await enteredTwice;
    try {
      const rejected = await preview().expect(429);
      expect(rejected.headers['retry-after']).toBe('1');
    } finally {
      unblock();
    }
    await Promise.all([first, second]);
  });

  it('keeps preview slots occupied until an aborted resolver actually settles', async () => {
    let aborted = 0;
    let signalBothAborted!: () => void;
    let allowResolverToFinish!: () => void;
    const bothAborted = new Promise<void>(resolve => { signalBothAborted = resolve; });
    const resolverGate = new Promise<void>(resolve => { allowResolverToFinish = resolve; });
    const appWithSlowResolver = express();
    appWithSlowResolver.use(express.json({ limit: '16kb' }));
    appWithSlowResolver.use('/api', createTrackingRouter(auth, signingSecret, {
      now: () => new Date(now),
      createPreview: createProductPreviewService({
        now: () => new Date(now), deadlineMs: 20,
        resolveProduct: (productId, signal) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted += 1;
            if (aborted === 2) signalBothAborted();
          }, { once: true });
          void resolverGate.then(async () => {
            try { resolve(await ProductModel.findById(productId).orFail().lean().exec()); }
            catch (error) { reject(error); }
          });
        }),
      }),
    }));

    const submit = () => request(appWithSlowResolver).post('/api/product-previews').send({ url: 'https://store.steampowered.com/app/620/' });
    let firstFinished = false;
    let secondFinished = false;
    const first = submit().expect(201).then(response => { firstFinished = true; return response; });
    const second = submit().expect(201).then(response => { secondFinished = true; return response; });
    try {
      await bothAborted;
      expect(firstFinished).toBe(false);
      expect(secondFinished).toBe(false);
      const third = await submit().expect(429);
      expect(third.headers['retry-after']).toBe('1');
    } finally {
      allowResolverToFinish();
    }
    await Promise.all([first, second]);
  });

  it('validates target/preferences strictly while accepting zero integer cents', async () => {
    const previewResult = await preview().expect(201);
    const base = { previewId: previewResult.body.id, targetPrice: { amountMinor: 0, currency: 'USD' }, enabled: true, alerts: { email: true, push: false } };
    for (const targetPrice of [
      { amountMinor: -1, currency: 'USD' }, { amountMinor: 0.5, currency: 'USD' },
      { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'USD' }, { amountMinor: 1, currency: 'EUR' },
    ]) {
      const response = await request(app).post('/api/tracked-items').set('Idempotency-Key', randomUUID()).send({ ...base, targetPrice }).expect(422);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    const extraField = await request(app).post('/api/tracked-items').set('Idempotency-Key', randomUUID()).send({ ...base, userId: String(new Types.ObjectId()) }).expect(422);
    expect(extraField.body.error.code).toBe('VALIDATION_ERROR');
    const created = await request(app).post('/api/tracked-items').set('Idempotency-Key', randomUUID()).send(base).expect(201);
    expect(created.body.targetPrice).toEqual({ amountMinor: 0, currency: 'USD' });
  });

  it('enforces owned unique products, returns a resource ID only for the owner, and supports CRUD/preferences', async () => {
    const previewResult = await preview().expect(201);
    const ownerId = principalUserId;
    const created = await createFromPreview(previewResult.body.id).expect(201);
    const id = created.body.id as string;
    expect(created.headers.location).toBe(`/api/tracked-items/${id}`);

    const duplicate = await createFromPreview(previewResult.body.id).expect(409);
    expect(duplicate.body.error).toMatchObject({ code: 'DUPLICATE_TRACKED_ITEM', resourceId: id });
    const get = await request(app).get(`/api/tracked-items/${id}`).expect(200);
    expect(get.body).toMatchObject({ id, targetPrice: { amountMinor: 500, currency: 'USD' }, alerts: { email: true, push: false } });

    const sameTarget = await request(app).patch(`/api/tracked-items/${id}`).send({ targetPrice: { amountMinor: 500, currency: 'USD' } }).expect(200);
    expect(sameTarget.body.targetPrice.amountMinor).toBe(500);
    expect((await TrackedItemModel.findById(id).lean())?.targetRevision).toBe(0);
    await request(app).patch(`/api/tracked-items/${id}`).send({ targetPrice: { amountMinor: 700, currency: 'USD' }, alerts: { email: false, push: true } }).expect(200);
    expect((await TrackedItemModel.findById(id).lean())?.targetRevision).toBe(1);

    principalUserId = String(new Types.ObjectId());
    await request(app).get(`/api/tracked-items/${id}`).expect(404);
    await request(app).patch(`/api/tracked-items/${id}`).send({ enabled: false }).expect(404);
    await request(app).delete(`/api/tracked-items/${id}`).expect(404);
    await request(app).get(`/api/tracked-items/${id}/history`).expect(404);
    expect((await request(app).post('/api/tracked-items').set('Idempotency-Key', randomUUID()).send({
      previewId: previewResult.body.id, targetPrice: { amountMinor: 400, currency: 'USD' }, enabled: true, alerts: { email: true, push: false },
    }).expect(404)).body.error.code).toBe('NOT_FOUND');

    const strangerPreview = await preview().expect(201);
    const strangerTracker = await createFromPreview(strangerPreview.body.id).expect(201);
    expect(strangerTracker.body.id).not.toBe(id);
    expect(await ProductModel.countDocuments({ _id: portalId })).toBe(1);

    principalUserId = ownerId;
    const observationId = new Types.ObjectId();
    await NotificationDeliveryModel.create({
      trackedItemId: id, userId: principalUserId, productId: portalId, observationId,
      episodeId: 'fixture-episode', channel: 'email', status: 'pending', availableAt: now,
    });
    await request(app).delete(`/api/tracked-items/${id}`).expect(204);
    expect(await TrackedItemModel.countDocuments({ _id: id })).toBe(0);
    expect(await TrackedItemModel.countDocuments({ _id: strangerTracker.body.id })).toBe(1);
    expect((await NotificationDeliveryModel.findOne({ trackedItemId: id }))?.status).toBe('cancelled');
    expect(await ProductModel.countDocuments({ _id: portalId })).toBe(1);
  });

  it('rejects a tampered or non-CheapShark purchase URL from the cached product', async () => {
    await ProductModel.updateOne({ _id: portalId }, { $set: { purchaseUrl: 'https://attacker.example/buy' } });
    const response = await preview().expect(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await ProductPreviewModel.countDocuments()).toBe(0);
  });

  it('replays identical idempotent creates before preview expiry and conflicts on changed bodies', async () => {
    const previewResult = await preview().expect(201);
    const key = randomUUID();
    const first = await createFromPreview(previewResult.body.id, key).expect(201);
    await ProductPreviewModel.updateOne({ _id: previewResult.body.id }, { $set: { expiresAt: new Date(now.getTime() - 1) } });
    const replay = await createFromPreview(previewResult.body.id, key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(await TrackedItemModel.countDocuments({ userId: principalUserId, productId: portalId })).toBe(1);
    await createFromPreview(previewResult.body.id, key, 501).expect(409)
      .then(response => expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT'));
  });

  it('serializes simultaneous same-key retries and does not duplicate the tracker', async () => {
    const previewResult = await preview().expect(201);
    const key = randomUUID();
    const submit = () => createFromPreview(previewResult.body.id, key);
    const [first, second] = await Promise.all([submit(), submit()]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body).toEqual(second.body);
    expect(first.headers.location).toBe(second.headers.location);
    expect(await TrackedItemModel.countDocuments({ userId: principalUserId, productId: portalId })).toBe(1);
    expect(await TrackingIdempotencyModel.countDocuments({ userId: principalUserId, key })).toBe(1);
  });

  it('returns the owned duplicate instead of creating two trackers during different-key races', async () => {
    const previewResult = await preview().expect(201);
    const submit = () => createFromPreview(previewResult.body.id, randomUUID());
    const results = await Promise.all([submit(), submit()]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    const created = results.find(result => result.status === 201)!;
    const duplicate = results.find(result => result.status === 409)!;
    expect(duplicate.body.error).toMatchObject({ code: 'DUPLICATE_TRACKED_ITEM', resourceId: created.body.id });
    expect(await TrackedItemModel.countDocuments({ userId: principalUserId, productId: portalId })).toBe(1);
  });

  it('returns 410 for an owned expired preview and 404 for a foreign preview', async () => {
    const previewResult = await preview().expect(201);
    await ProductPreviewModel.updateOne({ _id: previewResult.body.id }, { $set: { expiresAt: new Date(now.getTime() - 1) } });
    await createFromPreview(previewResult.body.id).expect(410)
      .then(response => expect(response.body.error.code).toBe('PREVIEW_EXPIRED'));
    principalUserId = String(new Types.ObjectId());
    await createFromPreview(previewResult.body.id).expect(404)
      .then(response => expect(response.body.error.code).toBe('NOT_FOUND'));
  });

  it('searches literal title substrings and paginates descending by creation time without leaking owners', async () => {
    const portalPreview = await preview().expect(201);
    await createFromPreview(portalPreview.body.id, randomUUID(), 500).expect(201);
    const ownerId = principalUserId;
    const halfLifePreview = await preview('https://store.steampowered.com/app/220/').expect(201);
    await createFromPreview(halfLifePreview.body.id, randomUUID(), 700).expect(201);
    principalUserId = String(new Types.ObjectId());
    await request(app).get('/api/tracked-items?q=portal').expect(200)
      .then(response => expect(response.body.items).toHaveLength(0));

    principalUserId = ownerId;
    const first = await request(app).get('/api/tracked-items?limit=1').expect(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.page.nextCursor).toEqual(expect.any(String));
    const second = await request(app).get(`/api/tracked-items?limit=1&cursor=${encodeURIComponent(first.body.page.nextCursor)}`).expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.page.nextCursor).toBeNull();
    expect(new Set([...first.body.items, ...second.body.items].map((item: { id: string }) => item.id)).size).toBe(2);
    const searched = await request(app).get('/api/tracked-items?q=portal').expect(200);
    expect(searched.body.items).toHaveLength(1);
    expect(searched.body.items[0].product.title).toBe('Portal 2');
    const regexIsLiteral = await request(app).get('/api/tracked-items?q=.%2A').expect(200);
    expect(regexIsLiteral.body.items).toHaveLength(0);
    const changedFilter = await request(app).get(`/api/tracked-items?q=half-life&cursor=${encodeURIComponent(first.body.page.nextCursor)}`).expect(422);
    expect(changedFilter.body.error.code).toBe('INVALID_CURSOR');
    await request(app).get('/api/tracked-items?limit=101').expect(422);
    await request(app).get('/api/tracked-items?limit=1&limit=2').expect(422);
  });

  it('rejects unsupported patch fields and malformed or missing request bodies', async () => {
    const previewResult = await preview().expect(201);
    const created = await createFromPreview(previewResult.body.id).expect(201);
    const unknownField = await request(app).patch(`/api/tracked-items/${created.body.id}`).send({ currentPrice: { amountMinor: 0, currency: 'USD' } }).expect(422);
    expect(unknownField.body.error.code).toBe('VALIDATION_ERROR');
    const emptyPatch = await request(app).patch(`/api/tracked-items/${created.body.id}`).send({}).expect(422);
    expect(emptyPatch.body.error.code).toBe('VALIDATION_ERROR');
    const badMedia = await request(app).post('/api/product-previews').type('text').send('not-json').expect(415);
    expect(badMedia.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('normalizes representative validation fields and validates every error envelope against OpenAPI', async () => {
    const malformedUrl = await preview('not a URL').expect(422);
    expect(validError(malformedUrl.body), JSON.stringify(validError.errors)).toBe(true);
    expect(malformedUrl.body.error.fields[0]).toMatchObject({ path: '/url', code: 'unsupported' });

    const wrongType = await request(app).post('/api/product-previews').send({ url: 620 }).expect(422);
    expect(validError(wrongType.body), JSON.stringify(validError.errors)).toBe(true);
    expect(wrongType.body.error.fields[0]).toMatchObject({ path: '/url', code: 'invalid_type' });

    const missingPreviewInput = await request(app).post('/api/product-previews').send({}).expect(422);
    expect(validError(missingPreviewInput.body), JSON.stringify(validError.errors)).toBe(true);
    expect(missingPreviewInput.body.error.fields[0]).toMatchObject({ path: '/url', code: 'required' });

    const unknownField = await request(app).post('/api/product-previews').send({ url: 'https://store.steampowered.com/app/620/', userId: 'spoofed' }).expect(422);
    expect(validError(unknownField.body), JSON.stringify(validError.errors)).toBe(true);
    expect(unknownField.body.error.fields).toContainEqual(expect.objectContaining({ path: '/userId', code: 'unknown_field' }));

    const previewResult = await preview().expect(201);
    const missingCreateInput = await request(app).post('/api/tracked-items').set('Idempotency-Key', randomUUID()).send({}).expect(422);
    expect(validError(missingCreateInput.body), JSON.stringify(validError.errors)).toBe(true);
    expect(missingCreateInput.body.error.fields).toContainEqual(expect.objectContaining({ path: '/previewId', code: 'required' }));

    const negativeCents = await request(app).post('/api/tracked-items').set('Idempotency-Key', randomUUID()).send({
      previewId: previewResult.body.id,
      targetPrice: { amountMinor: -1, currency: 'USD' },
      enabled: true,
      alerts: { email: true, push: false },
    }).expect(422);
    expect(validError(negativeCents.body), JSON.stringify(validError.errors)).toBe(true);
    expect(negativeCents.body.error.fields).toContainEqual(expect.objectContaining({ path: '/targetPrice/amountMinor', code: 'out_of_range' }));
  });

  it('returns history only through an owned tracker and preserves empty history', async () => {
    const previewResult = await preview().expect(201);
    const created = await createFromPreview(previewResult.body.id).expect(201);
    const history = await request(app).get(`/api/tracked-items/${created.body.id}/history`).expect(200);
    expect(history.body).toMatchObject({ trackedItemId: created.body.id, items: [], product: { steamAppId: '620' } });
    expect(history.body.page.nextCursor).toBeNull();
  });

  it('returns preview, tracker, and page shapes matching the shared OpenAPI schemas', async () => {
    const previewResult = await preview().expect(201);
    expect(validPreview(previewResult.body), JSON.stringify(validPreview.errors)).toBe(true);
    const created = await createFromPreview(previewResult.body.id).expect(201);
    expect(validTrackedItem(created.body), JSON.stringify(validTrackedItem.errors)).toBe(true);
    const list = await request(app).get('/api/tracked-items').expect(200);
    expect(validTrackedItemList(list.body), JSON.stringify(validTrackedItemList.errors)).toBe(true);
  });
});
