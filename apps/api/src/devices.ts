import mongoose from 'mongoose';
import { z } from 'zod';
import { DeviceModel, installationIdSchema } from './models/device.js';
import { SessionModel, UserModel } from './models/account.js';

export type MobilePrincipal = { userId: string; sessionId: string };
export class DeviceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const bodySchema = z.object({ installationId: installationIdSchema, platform: z.literal('android'), pushToken: z.string().min(1).max(4096) }).strict();
const id = /^[a-f0-9]{24}$/;
function parseBody(body: unknown) {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw new DeviceError(422, 'VALIDATION_ERROR', 'Invalid device registration.');
  return parsed.data;
}
async function assertPrincipal(principal: MobilePrincipal, session?: mongoose.ClientSession, now = new Date()) {
  if (!id.test(principal.userId) || !id.test(principal.sessionId)) throw new DeviceError(401, 'AUTH_REQUIRED', 'Sign in on Android.');
  const active = await SessionModel.findOne({ _id: principal.sessionId, userId: principal.userId, transport: 'mobile', revokedAt: null, expiresAt: { $gt: now } }).session(session ?? null).exec();
  const user = await UserModel.findOne({ _id: principal.userId, emailVerifiedAt: { $ne: null } }).session(session ?? null).exec();
  if (!active || !user) throw new DeviceError(401, 'SESSION_REVOKED', 'The mobile session is no longer active.');
}
const conflict = () => new DeviceError(409, 'DEVICE_CONFLICT', 'Device registration conflicts with an existing binding.');
function databaseError(error: unknown): never {
  if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) throw conflict();
  throw error;
}
type DeviceDocument = mongoose.HydratedDocument<mongoose.InferSchemaType<typeof DeviceModel.schema>>;
export function publicDevice(device: DeviceDocument) {
  return { id: String(device._id), installationId: device.installationId, platform: device.platform, sessionId: String(device.sessionId), createdAt: device.createdAt.toISOString(), updatedAt: device.updatedAt.toISOString() };
}

/** Authenticated token possession supports rebind of the same installation/token.
 * A guessed installation ID alone can never take another account's binding. */
export async function registerDevice(principal: MobilePrincipal, body: unknown) {
  const input = parseBody(body);
  try {
    return await mongoose.connection.transaction(async session => {
      await assertPrincipal(principal, session);
      const installed = await DeviceModel.findOne({ installationId: input.installationId }).select('+pushToken').session(session).exec();
      const tokenOwner = await DeviceModel.findOne({ pushToken: input.pushToken }).session(session).exec();
      if (tokenOwner && String(tokenOwner._id) !== String(installed?._id)) throw conflict();
      if (installed) {
        if (String(installed.userId) !== principal.userId && installed.pushToken !== input.pushToken) throw conflict();
        installed.userId = new mongoose.Types.ObjectId(principal.userId);
        installed.sessionId = new mongoose.Types.ObjectId(principal.sessionId);
        installed.pushToken = input.pushToken;
        installed.active = true;
        await installed.save({ session });
        return publicDevice(installed);
      }
      const [created] = await DeviceModel.create([{ userId: principal.userId, sessionId: principal.sessionId, ...input }], { session });
      return publicDevice(created!);
    });
  } catch (error) { return databaseError(error); }
}

export async function updateDevice(principal: MobilePrincipal, deviceId: string, body: unknown) {
  const input = parseBody(body);
  if (!id.test(deviceId)) throw new DeviceError(404, 'NOT_FOUND', 'Device not found.');
  try {
    return await mongoose.connection.transaction(async session => {
      await assertPrincipal(principal, session);
      const device = await DeviceModel.findOne({ _id: deviceId, userId: principal.userId, sessionId: principal.sessionId }).select('+pushToken').session(session).exec();
      if (!device) throw new DeviceError(404, 'NOT_FOUND', 'Device not found.');
      if (device.installationId !== input.installationId) throw conflict();
      device.pushToken = input.pushToken;
      device.active = true;
      await device.save({ session });
      return publicDevice(device);
    });
  } catch (error) { return databaseError(error); }
}

export async function removeDevice(principal: MobilePrincipal, deviceId: string) {
  await assertPrincipal(principal);
  if (!id.test(deviceId)) throw new DeviceError(404, 'NOT_FOUND', 'Device not found.');
  const result = await DeviceModel.deleteOne({ _id: deviceId, userId: principal.userId, sessionId: principal.sessionId }).exec();
  if (result.deletedCount !== 1) throw new DeviceError(404, 'NOT_FOUND', 'Device not found.');
}

/** Recover cleanup after process death without registering (and enabling) a device.
 * The installation UUID is only a selector; both current owner and session must match.
 * A missing/foreign/rebound binding is deliberately indistinguishable from removal. */
export async function removeDeviceInstallation(principal: MobilePrincipal, installationId: string) {
  await assertPrincipal(principal);
  const parsed = installationIdSchema.safeParse(installationId);
  if (!parsed.success) throw new DeviceError(422, 'VALIDATION_ERROR', 'Invalid installation ID.');
  await DeviceModel.deleteOne({ userId: principal.userId, sessionId: principal.sessionId, installationId: parsed.data }).exec();
}

/** Internal worker data only. Recheck just before each external send. */
export async function eligiblePushDevices(userId: string, now = new Date()) {
  if (!id.test(userId)) return [];
  if (!await UserModel.exists({ _id: userId, emailVerifiedAt: { $ne: null } })) return [];
  const sessions = await SessionModel.find({ userId, transport: 'mobile', revokedAt: null, expiresAt: { $gt: now } }).select('_id').lean().exec();
  return DeviceModel.find({ userId, active: true, sessionId: { $in: sessions.map(session => session._id) } }).select('+pushToken').lean().exec();
}

/** A late failed send for an old token/session must not deactivate a new binding. */
export async function deactivateInvalidDevice(deviceId: string, sessionId: string, token: string) {
  if (!id.test(deviceId) || !id.test(sessionId)) return;
  await DeviceModel.updateOne({ _id: deviceId, sessionId, pushToken: token }, { $set: { active: false } }).exec();
}
