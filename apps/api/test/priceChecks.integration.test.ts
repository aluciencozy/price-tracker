import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import mongoose, { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SteamOffer } from '../src/cheapshark.js';

const provider = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('../src/cheapshark.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/cheapshark.js')>();
  return { ...actual, lookupSteamOffer: provider.lookup };
});

import * as episodes from '../src/alertEpisodes.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { PriceCheckModel } from '../src/models/priceCheck.js';
import { ProductModel } from '../src/models/product.js';
import { NotificationDeliveryModel, PriceHistoryModel, TrackedItemModel } from '../src/models/tracking.js';
import { ProviderRateLimitError } from '../src/providerBudget.js';
import { getPriceCheckRun, runPriceChecks, resumeDuePriceChecks } from '../src/priceChecks.js';
import { CheckControlModel } from '../src/models/checkControl.js';
import { consumeAdminLimit, createAdminPriceCheckRouter } from '../src/adminPriceCheckRouter.js';
import express from 'express';
import request from 'supertest';
import { resolveApprovedProductPreview } from '../src/productPreviewResolver.js';
import { createPriceAlertDeliveryWorker } from '../src/alertDeliveryWorker.js';
import { UserModel } from '../src/models/account.js';
import { createTrackingRouter } from '../src/trackingRouter.js';
import { createManagedPriceChecks } from '../src/managedPriceChecks.js';

const uri = process.env.TEST_MONGODB_URI;
const DAY = 86_400_000;
const contract = JSON.parse(readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'));
const definitions = JSON.parse(JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
const ajv = new Ajv2020({ strict: true, strictTypes: false });
addFormats.default(ajv);
const validatePublicCheck = ajv.compile({ $defs: definitions, $ref: '#/$defs/PriceCheck' });
const validateRefresh = ajv.compile({ $defs: definitions, $ref: '#/$defs/RefreshRequest' });

describe.skipIf(!uri)('bounded price-check pipeline', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  let product620: string;
  const ownerA = new Types.ObjectId();
  const ownerB = new Types.ObjectId();

  const offer = (appId = '620', price = 999, at = new Date()): SteamOffer => ({
    identity: { provider: 'cheapshark', providerGameId: appId === '620' ? '36' : '59', storeId: '1', market: 'US', currency: 'USD' },
    steamAppId: appId,
    canonicalSteamUrl: `https://store.steampowered.com/app/${appId}/`,
    title: appId === '620' ? 'Portal 2' : 'Half-Life 2',
    storeName: 'Steam',
    source: { name: 'CheapShark', url: 'https://www.cheapshark.com/', attribution: 'offline fixture' },
    currentPrice: { amountMinor: price, currency: 'USD' },
    retailPrice: null,
    dealId: `fixture-${appId}`,
    purchaseUrl: `https://www.cheapshark.com/redirect?dealID=fixture-${appId}`,
    observedAt: at.toISOString(), providerChangedAt: null,
  });

  async function addProduct(appId = '620', firstUser = ownerA, target = 1_000) {
    const product = await ProductModel.create({
      provider: 'cheapshark', providerGameId: appId === '620' ? '36' : '59', steamAppId: appId,
      storeId: '1', market: 'US', currency: 'USD', canonicalSteamUrl: `https://store.steampowered.com/app/${appId}/`,
      title: appId === '620' ? 'Portal 2' : 'Half-Life 2',
    });
    await TrackedItemModel.create({ userId: firstUser, productId: product._id, targetPriceMinor: target });
    return String(product._id);
  }

  async function makeDue(productId: string) {
    await ProductModel.updateOne({ _id: productId }, { $set: {
      lastSuccessfulCheckAt: new Date(Date.now() - DAY - 1),
      nextCheckAt: new Date(Date.now() - DAY - 1),
      lastError: null,
    } }).exec();
  }

  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5_000 });
    await createDatabaseIndexes();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all([
      PriceCheckModel.deleteMany({}), ProductModel.deleteMany({}), TrackedItemModel.deleteMany({}),
      PriceHistoryModel.deleteMany({}), NotificationDeliveryModel.deleteMany({}),
      CheckControlModel.deleteMany({}),
    ]);
    product620 = await addProduct();
    await TrackedItemModel.create({ userId: ownerB, productId: product620, targetPriceMinor: 1_000, alerts: { email: true, push: false } });
    provider.lookup.mockImplementation(async (url: string) => offer(url.includes('/220/') ? '220' : '620'));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('requires a preselected user run and never returns the active admin run on contention', async () => {
    await expect(runPriceChecks({ runId: 'user_missing_0001', mode: 'user' })).rejects.toThrow('seeded');
    const tracker = await TrackedItemModel.findOne({ userId: ownerA }).orFail();
    await PriceCheckModel.create({ entryType: 'run', runId: 'user_queued_0001', mode: 'user', status: 'pending', selectionComplete: true, ownerUserId: ownerA, trackedItemId: tracker._id });
    await PriceCheckModel.create({ entryType: 'product', runId: 'user_queued_0001', mode: 'user', status: 'pending', productId: product620, checkId: 'pc_user_queued_0001' });
    await PriceCheckModel.create({ entryType: 'run', runId: 'admin_busy_0001', mode: 'admin', status: 'running' });
    await CheckControlModel.create({ _id: 'active', runId: 'admin_busy_0001', leaseUntil: new Date(Date.now() + 60_000) });
    const result = await runPriceChecks({ runId: 'user_queued_0001', mode: 'user' });
    expect(result.runId).toBe('user_queued_0001');
    expect(result.total).toBe(1);
    expect(provider.lookup).not.toHaveBeenCalled();
  });

  it('records a user-selected product even when all trackers are paused', async () => {
    await TrackedItemModel.updateMany({ productId: product620 }, { $set: { enabled: false } });
    const tracker = await TrackedItemModel.findOne({ userId: ownerA }).orFail();
    await TrackedItemModel.updateOne({ _id: tracker._id }, { $set: { refreshRunId: 'user_paused_0001' } });
    await PriceCheckModel.create({ entryType: 'run', runId: 'user_paused_0001', mode: 'user', status: 'pending', selectionComplete: true, ownerUserId: ownerA, trackedItemId: tracker._id });
    await PriceCheckModel.create({ entryType: 'product', runId: 'user_paused_0001', mode: 'user', status: 'pending', productId: product620, checkId: 'pc_user_paused_0001' });
    const result = await runPriceChecks({ runId: 'user_paused_0001', mode: 'user' });
    expect(result.counts.succeeded).toBe(1);
    expect(await PriceHistoryModel.countDocuments({ productId: product620 })).toBe(1);
    expect(await NotificationDeliveryModel.countDocuments({})).toBe(0);
    const updated = await TrackedItemModel.findById(tracker._id).orFail();
    expect(updated.refreshRunId).toBeNull();
    expect(updated.refreshCooldownUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('owns and coalesces HTTP refreshes, persists one child, and enforces cooldown', async () => {
    const tracker = await TrackedItemModel.findOne({ userId: ownerA }).orFail();
    await runPriceChecks({ runId: 'seed_cache_0001', mode: 'admin' });
    const queued: string[] = [];
    const app = express();
    app.use(express.json());
    app.use('/api', createTrackingRouter((req, res, next) => {
      res.locals.principal = { userId: req.get('x-owner') === 'other' ? String(ownerB) : String(ownerA), sessionId: 'fixture-session', role: 'user', transport: 'mobile' };
      next();
    }, 'fixture-signing-secret-at-least-32-chars', {
      createPreview: vi.fn(),
      runPriceChecks: async options => { queued.push(options.runId); return (await getPriceCheckRun(options.runId))!; },
    }));
    const post = () => request(app).post(`/api/tracked-items/${tracker.id}/refresh`).send({});
    const [first, second] = await Promise.all([post(), post()]);
    expect(first.status).toBe(202);
    expect(validateRefresh(first.body), JSON.stringify(validateRefresh.errors)).toBe(true);
    expect(second.status).toBe(202);
    expect(first.body.id).toBe(second.body.id);
    expect(first.headers.location).toBe(`/api/tracked-item-refreshes/${first.body.id}`);
    expect(await PriceCheckModel.countDocuments({ entryType: 'product', runId: first.body.id })).toBe(1);
    expect(queued).toHaveLength(1);
    expect((await request(app).get(first.headers.location!).set('x-owner', 'other')).status).toBe(404);
    expect((await request(app).post(`/api/tracked-items/${tracker.id}/refresh`).set('x-owner', 'other').send({})).status).toBe(404);
    expect((await request(app).post(`/api/tracked-items/${tracker.id}/refresh`).send({ force: true })).status).toBe(422);
    await runPriceChecks({ runId: first.body.id, mode: 'user' });
    const finished = await request(app).get(first.headers.location!);
    expect(finished.status).toBe(200);
    expect(finished.body.status).toBe('cached');
    expect(validateRefresh(finished.body), JSON.stringify(validateRefresh.errors)).toBe(true);
    expect(finished.body.lastObservation.price).toEqual({ amountMinor: 999, currency: 'USD' });
    expect(Object.keys(finished.body).sort()).toEqual(['id', 'trackedItemId', 'status', 'requestedAt', 'startedAt', 'finishedAt', 'lastObservation', 'retryAt', 'error'].sort());
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('dispatches committed work even when the post-commit status read fails', async () => {
    const tracker = await TrackedItemModel.findOne({ userId: ownerA }).orFail();
    const dispatched: string[] = [];
    const managed = createManagedPriceChecks(async options => {
      dispatched.push(options.runId);
      return (await getPriceCheckRun(options.runId))!;
    });
    const app = express();
    app.use(express.json());
    app.use('/api', createTrackingRouter((_req, res, next) => {
      res.locals.principal = { userId: String(ownerA), sessionId: 'read-failure-session', role: 'user', transport: 'mobile' };
      next();
    }, 'fixture-signing-secret-at-least-32-chars', { createPreview: vi.fn(), runPriceChecks: managed.run }));
    const brokenRead = vi.spyOn(ProductModel, 'findById').mockImplementationOnce(() => { throw new Error('fixture status read failure'); });
    await request(app).post(`/api/tracked-items/${tracker.id}/refresh`).send({}).expect(503);
    await managed.stop();
    brokenRead.mockRestore();
    expect(dispatched).toHaveLength(1);
    const persisted = await TrackedItemModel.findById(tracker._id).orFail();
    expect(persisted.refreshRunId).toBe(dispatched[0]);
    const item = await PriceCheckModel.findOne({ entryType: 'product', runId: dispatched[0] }).orFail();
    const recovered = await resumeDuePriceChecks();
    expect(recovered[0]?.runId).toBe(dispatched[0]);
    expect(recovered[0]?.checks[0]?.checkId).toBe(item.checkId);
    expect(recovered[0]?.counts.succeeded).toBe(1);
  });

  it('reevaluates a real cached observation after a target edit without duplicate deliveries', async () => {
    const tracker = await TrackedItemModel.findOne({ userId: ownerA }).orFail();
    await TrackedItemModel.updateOne({ _id: tracker._id }, { $set: { targetPriceMinor: 500, alerts: { email: true, push: true } } });
    await TrackedItemModel.updateOne({ userId: ownerB }, { $set: { enabled: false } });
    await runPriceChecks({ runId: 'target_seed_0001', mode: 'admin' });
    const observation = await PriceHistoryModel.findOne({ productId: product620 }).orFail();
    expect(observation.priceMinor).toBe(999);
    expect(await NotificationDeliveryModel.countDocuments({ trackedItemId: tracker._id })).toBe(0);
    expect(provider.lookup).toHaveBeenCalledTimes(1);

    const app = express();
    app.use(express.json());
    app.use('/api', createTrackingRouter((_req, res, next) => {
      res.locals.principal = { userId: String(ownerA), sessionId: 'target-edit-session', role: 'user', transport: 'mobile' };
      next();
    }, 'fixture-signing-secret-at-least-32-chars', {
      createPreview: vi.fn(), runPriceChecks: async options => (await getPriceCheckRun(options.runId))!,
    }));
    const post = () => request(app).post(`/api/tracked-items/${tracker.id}/refresh`).send({});
    const patchTarget = () => request(app).patch(`/api/tracked-items/${tracker.id}`).send({ targetPrice: { amountMinor: 1200, currency: 'USD' } });
    const first = await post().expect(202);
    expect((await post().expect(202)).body.id).toBe(first.body.id);
    await runPriceChecks({ runId: first.body.id, mode: 'user' });
    const firstResult = await request(app).get(first.headers.location!).expect(200);
    expect(firstResult.body.status).toBe('cached');
    expect(firstResult.body.lastObservation.id).toBe(String(observation._id));
    await post().expect(429);
    await patchTarget().expect(200);
    expect(await NotificationDeliveryModel.countDocuments({ trackedItemId: tracker._id })).toBe(0);
    // Advance only this disposable fixture's cooldown; no production clock or provider is changed.
    await TrackedItemModel.updateOne({ _id: tracker._id }, { $set: { refreshCooldownUntil: new Date(0) } });
    const second = await post().expect(202);
    await runPriceChecks({ runId: second.body.id, mode: 'user' });
    const secondResult = await request(app).get(second.headers.location!).expect(200);
    expect(secondResult.body.status).toBe('cached');
    expect(secondResult.body.lastObservation.id).toBe(String(observation._id));
    const deliveries = await NotificationDeliveryModel.find({ trackedItemId: tracker._id }).sort({ channel: 1 }).lean();
    expect(deliveries.map(delivery => delivery.channel)).toEqual(['email', 'push']);
    expect(deliveries.every(delivery => delivery.status === 'pending' && delivery.attempts === 0)).toBe(true);
    expect(new Set(deliveries.map(delivery => delivery.episodeId)).size).toBe(1);
    const revision = (await TrackedItemModel.findById(tracker._id).orFail()).targetRevision;
    await post().expect(429);
    await patchTarget().expect(200);
    expect((await TrackedItemModel.findById(tracker._id).orFail()).targetRevision).toBe(revision);
    await TrackedItemModel.updateOne({ _id: tracker._id }, { $set: { refreshCooldownUntil: new Date(0) } });
    const third = await post().expect(202);
    expect((await post().expect(202)).body.id).toBe(third.body.id);
    await runPriceChecks({ runId: third.body.id, mode: 'user' });
    const thirdResult = await request(app).get(third.headers.location!).expect(200);
    expect(thirdResult.body.status).toBe('cached');
    expect(thirdResult.body.lastObservation.id).toBe(String(observation._id));
    const replay = await NotificationDeliveryModel.find({ trackedItemId: tracker._id }).sort({ channel: 1 }).lean();
    expect(replay.map(delivery => String(delivery._id))).toEqual(deliveries.map(delivery => String(delivery._id)));
    expect(replay.every(delivery => delivery.attempts === 0)).toBe(true);
    expect(await PriceHistoryModel.countDocuments({ productId: product620 })).toBe(1);
    expect(provider.lookup).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed user selection before provider work', async () => {
    const tracker = await TrackedItemModel.findOne({ userId: ownerA }).orFail();
    await PriceCheckModel.create({ entryType: 'run', runId: 'user_invalid_0001', mode: 'user', status: 'pending', selectionComplete: true, ownerUserId: ownerA, trackedItemId: tracker._id });
    await expect(runPriceChecks({ runId: 'user_invalid_0001', mode: 'user' })).rejects.toThrow('exactly one');
    expect(provider.lookup).not.toHaveBeenCalled();
  });

  it('resumes the same deferred user run and child through the existing recovery worker', async () => {
    const tracker = await TrackedItemModel.findOne({ userId: ownerA }).orFail();
    const runId = 'user_recovery_0001';
    await TrackedItemModel.updateOne({ _id: tracker._id }, { $set: { refreshRunId: runId } });
    await PriceCheckModel.create({ entryType: 'run', runId, mode: 'user', status: 'pending', selectionComplete: true, ownerUserId: ownerA, trackedItemId: tracker._id });
    await PriceCheckModel.create({ entryType: 'product', runId, mode: 'user', status: 'pending', productId: product620, checkId: 'pc_user_recovery_0001' });
    provider.lookup.mockRejectedValueOnce(new ProviderRateLimitError(new Date(Date.now() + 60_000), '60'));
    const first = await runPriceChecks({ runId, mode: 'user' });
    expect(first.status).toBe('partial');
    expect(first.checks[0]?.errorCode).toBe('PROVIDER_RATE_LIMITED');
    expect((await TrackedItemModel.findById(tracker._id).orFail()).refreshRunId).toBe(runId);
    await PriceCheckModel.updateMany({ runId }, { $set: { nextRetryAt: new Date(0), availableAt: new Date(0) } });
    await ProductModel.updateOne({ _id: product620 }, { $set: { nextCheckAt: new Date(0) } });
    const recovered = await resumeDuePriceChecks();
    expect(recovered[0]?.runId).toBe(runId);
    expect(recovered[0]?.checks[0]?.checkId).toBe('pc_user_recovery_0001');
    expect(recovered[0]?.counts.succeeded).toBe(1);
    expect(await PriceHistoryModel.countDocuments({ productId: product620 })).toBe(1);
  });

  it('does not expose a private user run through admin polling or overlap', async () => {
    const runId = 'user_private_0001';
    await PriceCheckModel.create({ entryType: 'run', runId, mode: 'user', status: 'running' });
    await CheckControlModel.create({ _id: 'active', runId, leaseUntil: new Date(Date.now() + 60_000) });
    const admin = express();
    admin.use(express.json());
    admin.use('/api', createAdminPriceCheckRouter((_req, res, next) => {
      res.locals.principal = { userId: String(ownerA), sessionId: 'admin-fixture', role: 'admin', transport: 'mobile' };
      next();
    }));
    await request(admin).get(`/api/admin/price-checks/${runId}`).expect(404);
    const posted = await request(admin).post('/api/admin/price-checks').send({}).expect(202);
    expect(posted.body.id).not.toBe(runId);
    expect(posted.body.id).toMatch(/^admin_/);
  });

  it('delivers one pending episode after two qualifying checks without replacing its delivery key', async () => {
    await UserModel.create({ _id: ownerA, email: 'pending-check@example.invalid', passwordHash: 'fixture', emailVerifiedAt: new Date() });
    provider.lookup.mockResolvedValueOnce(offer('620', 900));
    await runPriceChecks({ runId: 'pending_alert_0001', mode: 'admin' });
    const first = await NotificationDeliveryModel.findOne({ userId: ownerA }).orFail();
    await makeDue(product620);
    provider.lookup.mockResolvedValueOnce(offer('620', 800));
    await runPriceChecks({ runId: 'pending_alert_0002', mode: 'admin' });
    const emailSender = vi.fn().mockResolvedValue({ status: 'success', messageId: 'fixture', attempts: 1 });
    const worker = createPriceAlertDeliveryWorker({ emailSender, pushSender: vi.fn() });
    await worker.runBatch();
    await worker.runBatch();
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(emailSender.mock.calls[0]?.[1]).toMatchObject({ currentPriceCents: 800 });
    const sent = await NotificationDeliveryModel.findById(first._id).orFail();
    expect(sent.status).toBe('sent');
    expect(sent.episodeId).toBe(first.episodeId);
    expect(await NotificationDeliveryModel.countDocuments({ userId: ownerA })).toBe(1);
  });

  it('checks one shared product for two users once across overlap, retry and restart replay', async () => {
    let releaseLookup!: (value: SteamOffer) => void;
    provider.lookup.mockImplementationOnce(() => new Promise(resolve => { releaseLookup = resolve; }));
    const first = runPriceChecks({ runId: 'overlap_run_0001', mode: 'scheduled' });
    await vi.waitFor(() => expect(provider.lookup).toHaveBeenCalledTimes(1));
    const overlap = await runPriceChecks({ runId: 'overlap_run_0001', mode: 'scheduled' });
    expect(overlap.status).toBe('running');
    releaseLookup(offer());
    const completed = await first;
    expect(completed.counts.succeeded).toBe(1);
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    expect(await PriceHistoryModel.countDocuments({ productId: product620 })).toBe(1);
    expect(await PriceCheckModel.countDocuments({ entryType: 'product', runId: 'overlap_run_0001' })).toBe(1);
    expect(await NotificationDeliveryModel.countDocuments()).toBe(2);
    expect(await TrackedItemModel.countDocuments({ productId: product620, episodeOpen: true })).toBe(2);

    await mongoose.disconnect();
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5_000 });
    const replay = await runPriceChecks({ runId: 'overlap_run_0001', mode: 'scheduled' });
    expect(replay.status).toBe('complete');
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    expect(await PriceHistoryModel.countDocuments({ productId: product620 })).toBe(1);
    expect(await NotificationDeliveryModel.countDocuments()).toBe(2);
  });

  it('recovers after history commits but alert evaluation crashes without fetching or recording twice', async () => {
    const evaluate = vi.spyOn(episodes, 'evaluateTrackerObservation').mockRejectedValueOnce(new Error('simulated worker crash'));
    const first = await runPriceChecks({ runId: 'restart_run_0001', mode: 'admin' });
    expect(first.status).toBe('partial');
    expect(first.counts.failed).toBe(1);
    expect(await PriceHistoryModel.countDocuments({ productId: product620 })).toBe(1);

    const retryAt = new Date(Date.now() - 1);
    await PriceCheckModel.updateOne({ entryType: 'product', runId: 'restart_run_0001' }, { $set: { availableAt: retryAt, nextRetryAt: retryAt } });
    await PriceCheckModel.updateOne({ entryType: 'run', runId: 'restart_run_0001' }, { $set: { nextRetryAt: retryAt } });
    const recovered = await runPriceChecks({ runId: 'restart_run_0001', mode: 'admin' });
    evaluate.mockRestore();

    expect(recovered.status).toBe('complete');
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    expect(await PriceHistoryModel.countDocuments({ productId: product620 })).toBe(1);
    expect(await NotificationDeliveryModel.countDocuments()).toBe(2);
    expect((await getPriceCheckRun('restart_run_0001'))?.counts.succeeded).toBe(1);
  });

  it('recovers a durable queued admin run after a crash before product selection', async () => {
    await PriceCheckModel.create({ entryType: 'run', runId: 'queued_admin_crash', mode: 'admin', status: 'pending' });
    await CheckControlModel.create({ _id: 'active', runId: 'queued_admin_crash', leaseUntil: new Date(0) });
    const recovered = await resumeDuePriceChecks();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.runId).toBe('queued_admin_crash');
    expect(recovered[0]?.status).toBe('complete');
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    expect(await PriceHistoryModel.countDocuments()).toBe(1);
    expect(await NotificationDeliveryModel.countDocuments()).toBe(2);
  });

  it('does not rearm on failure, rearms above target and opens one later episode', async () => {
    provider.lookup
      .mockResolvedValueOnce(offer('620', 900))
      .mockRejectedValueOnce(new Error('offline fixture failure'))
      .mockResolvedValueOnce(offer('620', 1_200))
      .mockResolvedValueOnce(offer('620', 800));

    const low = await runPriceChecks({ runId: 'episode_run_0001', mode: 'admin' });
    const trackerId = String((await TrackedItemModel.findOne({ productId: product620, userId: ownerA }).exec())!._id);
    const firstEpisode = (await TrackedItemModel.findById(trackerId).lean().exec())?.episodeId;
    expect(low.counts.succeeded).toBe(1);
    expect((await TrackedItemModel.findById(trackerId).lean().exec())?.episodeOpen).toBe(true);

    await makeDue(product620);
    const failure = await runPriceChecks({ runId: 'episode_run_0002', mode: 'admin' });
    expect(failure.counts.failed).toBe(1);
    expect((await TrackedItemModel.findById(trackerId).lean().exec())?.episodeOpen).toBe(true);
    expect((await TrackedItemModel.findById(trackerId).lean().exec())?.episodeId).toBe(firstEpisode);
    expect(await PriceHistoryModel.countDocuments({ productId: product620 })).toBe(1);

    await makeDue(product620);
    const high = await runPriceChecks({ runId: 'episode_run_0003', mode: 'admin' });
    expect(high.counts.succeeded).toBe(1);
    expect((await TrackedItemModel.findById(trackerId).lean().exec())?.episodeOpen).toBe(false);
    expect((await TrackedItemModel.findById(trackerId).lean().exec())?.episodeId).toBeNull();

    await makeDue(product620);
    const nextLow = await runPriceChecks({ runId: 'episode_run_0004', mode: 'admin' });
    expect(nextLow.counts.succeeded).toBe(1);
    expect((await TrackedItemModel.findById(trackerId).lean().exec())?.episodeOpen).toBe(true);
    expect((await TrackedItemModel.findById(trackerId).lean().exec())?.episodeId).not.toBe(firstEpisode);
    expect(await PriceHistoryModel.countDocuments({ productId: product620 })).toBe(3);
    expect(await NotificationDeliveryModel.countDocuments({ status: 'pending' })).toBe(2);
    expect(await NotificationDeliveryModel.countDocuments({ status: 'cancelled' })).toBe(2);
  });

  it('continues later Products after a failure and respects Retry-After on a 429', async () => {
    const product220 = await addProduct('220', new Types.ObjectId());
    const retryAt = new Date(Date.now() + 120_000);
    provider.lookup.mockImplementation(async (url: string) => {
      if (url.includes('/620/')) throw new ProviderRateLimitError(retryAt, '120');
      return offer('220', 0);
    });

    const partial = await runPriceChecks({ runId: 'partial_run_0001', mode: 'scheduled' });
    expect(partial.counts.failed).toBe(1);
    expect(partial.counts.succeeded).toBe(1);
    expect(partial.checks.find(check => check.productId === product620)?.nextRetryAt).toBe(retryAt.toISOString());
    expect((await ProductModel.findById(product620).lean())?.currentPriceMinor).toBeNull();
    expect((await ProductModel.findById(product220).lean())?.currentPriceMinor).toBe(0);
    expect(provider.lookup).toHaveBeenCalledTimes(2);

    const replayBeforeRetry = await runPriceChecks({ runId: 'partial_run_0001', mode: 'scheduled' });
    expect(replayBeforeRetry.counts.failed).toBe(1);
    expect(provider.lookup).toHaveBeenCalledTimes(2);
  });

  it('fetches a genuine first observation after a preview-only cache update, then replays once', async () => {
    const previewTime = new Date(Date.now() - 1_000);
    await ProductModel.updateOne({ _id: product620 }, { $set: {
      currentPriceMinor: 999, lastSuccessfulCheckAt: previewTime, lastError: null,
      nextCheckAt: new Date(Date.now() + DAY),
    } });
    const first = await runPriceChecks({ runId: 'preview_run_0001', mode: 'admin' });
    expect(first.counts.succeeded).toBe(1);
    const observation = await PriceHistoryModel.findOne({ productId: product620 }).lean();
    expect(observation!.observedAt.getTime()).toBeGreaterThan(previewTime.getTime());
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    await runPriceChecks({ runId: 'preview_run_0001', mode: 'admin' });
    await runPriceChecks({ runId: 'preview_run_0002', mode: 'scheduled' });
    expect(provider.lookup).toHaveBeenCalledTimes(1);
    expect(await PriceHistoryModel.countDocuments()).toBe(1);
    expect(await NotificationDeliveryModel.countDocuments()).toBe(2);
  });

  it('eventually visits products past the first bounded 100-product page', async () => {
    const rows = Array.from({ length: 104 }, (_, index) => ({
      provider: 'cheapshark', providerGameId: String(1000 + index), steamAppId: String(1000 + index),
      storeId: '1', market: 'US', currency: 'USD', canonicalSteamUrl: `https://store.steampowered.com/app/${1000 + index}/`, title: 'offline fixture',
    }));
    const products = await ProductModel.insertMany(rows);
    await TrackedItemModel.insertMany(products.map(product => ({ userId: ownerA, productId: product._id, targetPriceMinor: 1000 })));
    provider.lookup.mockRejectedValue(new Error('fixture unsupported'));
    const first = await runPriceChecks({ runId: 'fairness_run_001', mode: 'scheduled' });
    expect(first.total).toBe(100);
    expect(first.truncated).toBe(true);
    const second = await runPriceChecks({ runId: 'fairness_run_002', mode: 'scheduled' });
    expect(second.total).toBe(5);
    expect(new Set([...first.checks, ...second.checks].map(row => row.productId)).size).toBe(105);
  });

  it('rolls back selection and its cursor together on a crash before the page is durable', async () => {
    const update = PriceCheckModel.updateOne.bind(PriceCheckModel);
    const failure = vi.spyOn(PriceCheckModel, 'updateOne').mockImplementation((...args) => {
      const change = args[1] as { $set?: { selectionComplete?: boolean } } | undefined;
      if (change?.$set?.selectionComplete) throw new Error('fixture selection crash');
      return update(...args);
    });
    try {
      await expect(runPriceChecks({ runId: 'selection_crash_01', mode: 'admin' })).rejects.toThrow('fixture selection crash');
    } finally { failure.mockRestore(); }
    expect(await CheckControlModel.findById('selection').lean()).toBeNull();
    expect(await PriceCheckModel.countDocuments({ entryType: 'product' })).toBe(0);
    await PriceCheckModel.updateOne({ entryType: 'run', runId: 'selection_crash_01' }, { $set: { nextRetryAt: new Date(0) } });
    const recovered = await runPriceChecks({ runId: 'selection_crash_01', mode: 'admin' });
    expect(recovered.counts.succeeded).toBe(1);
    expect(await PriceHistoryModel.countDocuments()).toBe(1);
  });

  it('enforces durable limits across calls and isolates admin action/poll buckets', async () => {
    const at = Date.now();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => consumeAdminLimit(String(ownerA), 'enqueue', at)));
    expect(outcomes.filter(value => value === null)).toHaveLength(1);
    expect(await consumeAdminLimit(String(ownerB), 'enqueue', at)).toBeNull();
    for (let index = 0; index < 12; index++) expect(await consumeAdminLimit(String(ownerA), 'poll', at)).toBeNull();
    expect(await consumeAdminLimit(String(ownerA), 'poll', at)).toBeGreaterThan(0);
  });

  it('keeps the enqueue limit across independent Node processes and reconnects', async () => {
    const at = Date.now();
    const child = () => new Promise<number | null>((resolve, reject) => {
      const source = `import mongoose from 'mongoose';
        import { consumeAdminLimit } from './src/adminPriceCheckRouter.ts';
        await mongoose.connect(process.env.TEST_MONGODB_URI, {dbName:${JSON.stringify(dbName)},autoIndex:false});
        console.log(JSON.stringify(await consumeAdminLimit(${JSON.stringify(String(ownerA))},'enqueue',${at})));
        await mongoose.disconnect();`;
      const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        cwd: new URL('..', import.meta.url), env: { ...process.env, TEST_MONGODB_URI: uri! }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      worker.stdout.on('data', chunk => { output += String(chunk); });
      worker.on('error', reject);
      worker.on('exit', code => {
        if (code !== 0) reject(new Error('Offline limiter test worker failed.'));
        else resolve(JSON.parse(output.trim()));
      });
    });
    const outcomes = await Promise.all([child(), child(), child()]);
    expect(outcomes.filter(value => value === null)).toHaveLength(1);
    expect(await consumeAdminLimit(String(ownerA), 'enqueue', at)).toBeGreaterThan(0);
  });

  it('coalesces scheduled/manual overlap and a same-run replay cannot unlock the active owner', async () => {
    let release!: (value: SteamOffer) => void;
    provider.lookup.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const scheduled = runPriceChecks({ runId: 'coalesce_scheduled_01', mode: 'scheduled' });
    await vi.waitFor(() => expect(provider.lookup).toHaveBeenCalledTimes(1));
    const originalControl = await CheckControlModel.findById('active').lean();
    const replay = await runPriceChecks({ runId: 'coalesce_scheduled_01', mode: 'scheduled' });
    expect(replay.status).toBe('running');
    expect((await CheckControlModel.findById('active').lean())?.leaseToken).toBe(originalControl?.leaseToken);
    const app = express();
    app.use(express.json());
    app.use('/api', createAdminPriceCheckRouter((_req, res, next) => {
      res.locals.principal = { userId: String(ownerB), sessionId: 'fixture', transport: 'mobile', role: 'admin' };
      next();
    }));
    try {
      const response = await request(app).post('/api/admin/price-checks').send({}).expect(202);
      expect(response.body.id).toBe('coalesce_scheduled_01');
      expect(response.body.trigger).toBe('scheduled');
      expect(await PriceCheckModel.countDocuments({ entryType: 'run' })).toBe(1);
      expect(provider.lookup).toHaveBeenCalledTimes(1);
      await request(app).post('/api/admin/price-checks').send({}).expect(429);
    } finally { release(offer()); await scheduled; }
  });

  it('aborts a genuinely stalled database preview read before any provider request starts', async () => {
    const read = vi.spyOn(ProductModel, 'findById').mockImplementation(() => ProductModel.findOne({
      _id: product620, $where: 'sleep(5000); return true;',
    }));
    const controller = new AbortController();
    const started = Date.now();
    const pending = resolveApprovedProductPreview(product620, controller.signal);
    const result = pending.catch(error => error);
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const error = await result;
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(provider.lookup).not.toHaveBeenCalled();
    } finally { clearTimeout(timer); read.mockRestore(); }
  });

  it('returns 202 Location and an aggregate response; all verified admins can poll but users cannot', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createAdminPriceCheckRouter((req, res, next) => {
      res.locals.principal = { userId: String(ownerA), sessionId: 'fixture', transport: 'mobile', role: req.get('fixture-role') ?? 'admin' };
      next();
    }));
    const accepted = await request(app).post('/api/admin/price-checks').send({}).expect(202);
    expect(validatePublicCheck(accepted.body), JSON.stringify(validatePublicCheck.errors)).toBe(true);
    expect(accepted.headers.location).toBe(`/api/admin/price-checks/${accepted.body.id}`);
    expect(accepted.body).not.toHaveProperty('checks');
    expect(accepted.body).not.toHaveProperty('data');
    await request(app).get(accepted.headers.location!).expect(200);
    await request(app).get(accepted.headers.location!).set('fixture-role', 'user').expect(403);
    await vi.waitFor(async () => expect((await getPriceCheckRun(accepted.body.id))?.status).toBe('complete'));
    const completed = await request(app).get(accepted.headers.location!).expect(200);
    expect(validatePublicCheck(completed.body), JSON.stringify(validatePublicCheck.errors)).toBe(true);
    expect(completed.body.status).toBe('succeeded');
  });
});
