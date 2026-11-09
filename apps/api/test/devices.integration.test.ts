import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createDatabaseIndexes } from '../src/models/index.js';
import { DeviceModel } from '../src/models/device.js';
import { SessionModel, UserModel } from '../src/models/account.js';
import { registerDevice, updateDevice, removeDevice, removeDeviceInstallation, eligiblePushDevices, deactivateInvalidDevice, DeviceError, type MobilePrincipal } from '../src/devices.js';
import { createDeviceRouter } from '../src/deviceRouter.js';

const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('owned Android device bindings', () => {
  const dbName = `price_tracker_test_${randomUUID().replaceAll('-', '')}`;
  const owner = new Types.ObjectId();
  const other = new Types.ObjectId();
  let principal: MobilePrincipal;
  let another: MobilePrincipal;
  const body = () => ({ installationId: randomUUID(), platform: 'android', pushToken: randomUUID() });
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    await createDatabaseIndexes();
  });
  beforeEach(async () => {
    await Promise.all([UserModel.deleteMany({}), SessionModel.deleteMany({}), DeviceModel.deleteMany({})]);
    await UserModel.create([{ _id: owner, email: 'owner@example.invalid', passwordHash: 'offline-fixture', emailVerifiedAt: new Date() }, { _id: other, email: 'other@example.invalid', passwordHash: 'offline-fixture', emailVerifiedAt: new Date() }]);
    const sessions = await SessionModel.create([owner, other].map(userId => ({ userId, transport: 'mobile' as const, expiresAt: new Date(Date.now() + 86400000) })));
    principal = { userId: String(owner), sessionId: String(sessions[0]!._id) };
    another = { userId: String(other), sessionId: String(sessions[1]!._id) };
  });
  afterAll(async () => {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  it('registers repeatably with no token/user fields in the response', async () => {
    const input = body();
    const first = await registerDevice(principal, input);
    const again = await registerDevice(principal, input);
    expect(again.id).toBe(first.id);
    expect(Object.keys(first).sort()).toEqual(['id', 'installationId', 'platform', 'sessionId', 'createdAt', 'updatedAt'].sort());
    expect(await DeviceModel.countDocuments()).toBe(1);
  });
  it('rotates a token without changing device ID; late invalidation cannot disable the replacement', async () => {
    const input = body();
    const first = await registerDevice(principal, input);
    const rotated = await updateDevice(principal, first.id, { ...input, pushToken: 'rotated-fixture' });
    expect(rotated.id).toBe(first.id);
    await deactivateInvalidDevice(first.id, principal.sessionId, input.pushToken);
    expect((await DeviceModel.findById(first.id))?.active).toBe(true);
    await deactivateInvalidDevice(first.id, principal.sessionId, 'rotated-fixture');
    expect((await DeviceModel.findById(first.id))?.active).toBe(false);
  });
  it('registers UUIDv7 and treats UUID letter case as the same installation during rotation and account switching', async () => {
    const input = { ...body(), installationId: '019A50A0-0000-7000-8000-000000000001' };
    const first = await registerDevice(principal, input);
    expect(first.installationId).toBe(input.installationId.toLowerCase());
    const again = await registerDevice(principal, { ...input, installationId: input.installationId.toLowerCase() });
    expect(again.id).toBe(first.id);
    const rotatedInput = { ...input, pushToken: 'rotated-uuid-fixture' };
    expect((await updateDevice(principal, first.id, rotatedInput)).id).toBe(first.id);
    const rebound = await registerDevice(another, { ...rotatedInput, installationId: input.installationId.toLowerCase() });
    expect(rebound.id).toBe(first.id);
    expect(await eligiblePushDevices(principal.userId)).toHaveLength(0);
    expect(await eligiblePushDevices(another.userId)).toHaveLength(1);
    expect(await DeviceModel.countDocuments()).toBe(1);
  });
  it('rebinds the same installation/token to the new signed-in account and removes old eligibility', async () => {
    const input = body();
    const first = await registerDevice(principal, input);
    const rebound = await registerDevice(another, input);
    expect(rebound.id).toBe(first.id);
    expect(rebound.sessionId).toBe(another.sessionId);
    expect(await eligiblePushDevices(principal.userId)).toHaveLength(0);
    expect(await eligiblePushDevices(another.userId)).toHaveLength(1);
    await expect(removeDevice(principal, first.id)).rejects.toMatchObject({ status: 404 });
  });
  it('cannot steal a binding with only its installation UUID or move another installation token', async () => {
    const input = body();
    await registerDevice(principal, input);
    await expect(registerDevice(another, { ...input, pushToken: 'different-token' })).rejects.toMatchObject({ code: 'DEVICE_CONFLICT' });
    await expect(registerDevice(another, { ...input, installationId: randomUUID() })).rejects.toMatchObject({ code: 'DEVICE_CONFLICT' });
    expect(await eligiblePushDevices(principal.userId)).toHaveLength(1);
  });
  it('requires current-session ownership for rotation and removal', async () => {
    const input = body();
    const first = await registerDevice(principal, input);
    await expect(updateDevice(another, first.id, input)).rejects.toMatchObject({ status: 404 });
    await expect(removeDevice(another, first.id)).rejects.toMatchObject({ status: 404 });
    await removeDevice(principal, first.id);
    expect(await DeviceModel.countDocuments()).toBe(0);
  });
  it('does not remove an installation rebound between principal validation and the atomic delete', async () => {
    const input = body();
    const device = await registerDevice(principal, input);
    const deletion = DeviceModel.deleteOne({ userId: principal.userId, sessionId: principal.sessionId, installationId: input.installationId });
    const execute = deletion.exec.bind(deletion);
    vi.spyOn(deletion, 'exec').mockImplementationOnce(async () => {
      await registerDevice(another, input);
      return execute();
    });
    const remove = vi.spyOn(DeviceModel, 'deleteOne').mockReturnValueOnce(deletion);
    try {
      await removeDeviceInstallation(principal, input.installationId);
      expect(remove).toHaveBeenCalledWith({ userId: principal.userId, sessionId: principal.sessionId, installationId: input.installationId });
      expect((await DeviceModel.findById(device.id))?.sessionId.toString()).toBe(another.sessionId);
      expect(await eligiblePushDevices(another.userId)).toHaveLength(1);
    } finally { remove.mockRestore(); }
  });
  it('rechecks verified active mobile principal before installation cleanup', async () => {
    const input = body();
    await registerDevice(principal, input);
    await SessionModel.updateOne({ _id: principal.sessionId }, { $set: { revokedAt: new Date() } });
    await expect(removeDeviceInstallation(principal, input.installationId)).rejects.toMatchObject({ status: 401 });
    await SessionModel.updateOne({ _id: principal.sessionId }, { $set: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
    await expect(removeDeviceInstallation(principal, input.installationId)).rejects.toMatchObject({ status: 401 });
    await SessionModel.updateOne({ _id: principal.sessionId }, { $set: { expiresAt: new Date(Date.now() + 86400000) } });
    await UserModel.updateOne({ _id: owner }, { $set: { emailVerifiedAt: null } });
    await expect(removeDeviceInstallation(principal, input.installationId)).rejects.toMatchObject({ status: 401 });
    expect(await DeviceModel.countDocuments()).toBe(1);
  });
  it('does not deliver to revoked/expired sessions or unverified users even if a device row remains', async () => {
    await registerDevice(principal, body());
    await SessionModel.updateOne({ _id: principal.sessionId }, { $set: { revokedAt: new Date() } });
    expect(await eligiblePushDevices(principal.userId)).toHaveLength(0);
    await expect(registerDevice(principal, body())).rejects.toMatchObject({ status: 401 });
    await SessionModel.updateOne({ _id: principal.sessionId }, { $set: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
    expect(await eligiblePushDevices(principal.userId)).toHaveLength(0);
    await SessionModel.updateOne({ _id: principal.sessionId }, { $set: { expiresAt: new Date(Date.now() + 86400000) } });
    await UserModel.updateOne({ _id: owner }, { $set: { emailVerifiedAt: null } });
    expect(await eligiblePushDevices(principal.userId)).toHaveLength(0);
    await expect(registerDevice(principal, body())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects unknown owner/session fields and invalid request shapes', async () => {
    for (const input of [{ ...body(), userId: principal.userId }, { ...body(), sessionId: principal.sessionId }, { ...body(), pushToken: '' }, { ...body(), platform: 'ios' }, { ...body(), installationId: 'not-a-uuid' }]) {
      await expect(registerDevice(principal, input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(await DeviceModel.countDocuments()).toBe(0);
  });
  it('serves exact device route statuses and enforces the injected auth boundary', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createDeviceRouter(async () => principal));
    const input = body();
    const created = await request(app).post('/api/devices').send(input);
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('pushToken');
    expect((await request(app).put(`/api/devices/${created.body.id}`).send({ ...input, pushToken: 'rotate' })).status).toBe(200);
    expect((await request(app).delete(`/api/devices/${created.body.id}`)).status).toBe(204);
    const denied = express();
    denied.use('/api', createDeviceRouter(async () => { throw new DeviceError(401, 'AUTH_REQUIRED', 'Sign in.'); }));
    expect((await request(denied).post('/api/devices')).status).toBe(401);
  });
});
