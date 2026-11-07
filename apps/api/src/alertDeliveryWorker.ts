import { createHash, randomUUID } from 'node:crypto';
import mongoose, { Types, type InferSchemaType } from 'mongoose';
import { sendPriceAlert, type DeliveryOutcome, type PriceAlertEmail } from './emails.js';
import { EmailSendDeferred } from './emails.js';
import { deactivateInvalidDevice, eligiblePushDevices } from './devices.js';
import type { PushEvent, PushOutcome } from './fcm.js';
import { pushEventSchema } from './fcm.js';
import { cheapSharkPurchaseUrl } from './cheapshark.js';
import { UserModel } from './models/account.js';
import { ProductModel } from './models/product.js';
import { NotificationDeliveryModel, PriceHistoryModel, TrackedItemModel } from './models/tracking.js';

const EMAIL_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Leave room for all three bounded Resend calls plus delays, and small clock/network
// variance, so a request is not intentionally begun at the edge of the 24-hour window.
const EMAIL_SEND_WALL_LIMIT_MS = 17_000;
const EMAIL_WINDOW_MARGIN_MS = 30_000;
const EMAIL_RETRY_CUTOFF_MS = EMAIL_IDEMPOTENCY_WINDOW_MS - EMAIL_SEND_WALL_LIMIT_MS - EMAIL_WINDOW_MARGIN_MS;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 45_000;
const MAX_LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;
const BASE_RETRY_DELAY_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const projection = '+leaseToken +idempotencyKey +emailPayload +pushPayload +pushDevices +providerMessageId';

type Channel = 'email' | 'push';
type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'retryable' | 'permanent_failure' | 'unknown' | 'cancelled';
type RecipientStatus = 'pending' | 'sending' | 'accepted' | 'retryable' | 'permanent_failure' | 'unknown' | 'cancelled';

type EmailSnapshot = PriceAlertEmail & { recipient: string };
type PushSnapshot = Omit<PushEvent, 'recipientSessionId'>;
type PushRecipient = {
  deviceId: Types.ObjectId;
  sessionId: Types.ObjectId;
  tokenHash: string;
  status: RecipientStatus;
  attempts: number;
  availableAt: Date;
  providerMessageId: string | null;
  lastErrorCode: string | null;
};
type Delivery = {
  _id: Types.ObjectId;
  trackedItemId: Types.ObjectId;
  userId: Types.ObjectId;
  productId: Types.ObjectId;
  observationId: Types.ObjectId;
  episodeId: string;
  channel: Channel;
  status: DeliveryStatus;
  attempts: number;
  availableAt: Date;
  firstAttemptAt: Date | null;
  emailUncertain: boolean;
  leaseToken: string | null;
  leaseUntil: Date | null;
  idempotencyKey: string | null;
  emailPayload: EmailSnapshot | null;
  pushPayload: PushSnapshot | null;
  pushDevices: PushRecipient[] | null;
};
type DeliveryShape = InferSchemaType<typeof NotificationDeliveryModel.schema>;
type LiveContext = {
  recipient: string;
  gameTitle: string;
  currentPriceCents: number;
  targetPriceCents: number;
  purchaseUrl: string;
  observedAt: Date;
  productId: Types.ObjectId;
};

class FreshObservationUnavailable extends Error {}

export type PriceAlertEmailSender = typeof sendPriceAlert;
export type PriceAlertPushSender = (token: string, event: unknown) => Promise<PushOutcome>;
export type AlertDeliveryWorkerOptions = {
  /** Required by design: construct with createFirebaseFcmSender(projectId) at integration time. */
  pushSender: PriceAlertPushSender;
  emailSender?: PriceAlertEmailSender;
  batchSize?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  /** Receives fixed safe codes only; provider errors and tokens are never passed through. */
  onError?: (code: string) => void;
};

export type AlertDeliveryBatchResult = {
  claimed: number;
  sent: number;
  retryable: number;
  permanentFailure: number;
  unknown: number;
  cancelled: number;
};

const idString = (value: Types.ObjectId | string) => String(value);
const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
const isObjectId = (value: unknown): value is Types.ObjectId => value instanceof Types.ObjectId;

function safeCode(code: string): string {
  return /^[A-Za-z0-9_-]{1,100}$/.test(code) ? code : 'PROVIDER_OUTCOME_UNKNOWN';
}

function retryDelayMs(attempt: number, providerDelay?: number): number {
  const backoff = Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  const requested = Number.isFinite(providerDelay) && (providerDelay ?? 0) > 0 ? providerDelay! : 0;
  return Math.min(Math.max(backoff, requested), MAX_RETRY_DELAY_MS);
}

function emailRetryCutoff(firstAttemptAt: Date): Date {
  return new Date(firstAttemptAt.getTime() + EMAIL_RETRY_CUTOFF_MS);
}

function emailRetryIsSafe(firstAttemptAt: Date, now: Date): boolean {
  return now.getTime() < emailRetryCutoff(firstAttemptAt).getTime();
}

function makeEmailSnapshot(context: LiveContext): EmailSnapshot {
  return {
    recipient: context.recipient,
    gameTitle: context.gameTitle,
    currentPriceCents: context.currentPriceCents,
    targetPriceCents: context.targetPriceCents,
    purchaseUrl: context.purchaseUrl,
  };
}

function makePushSnapshot(delivery: Delivery, context: LiveContext): PushSnapshot {
  return {
    schemaVersion: '1',
    type: 'price_target_reached',
    eventId: delivery.episodeId,
    deliveryId: idString(delivery._id),
    trackedItemId: idString(delivery.trackedItemId),
    productId: idString(context.productId),
    observedAt: context.observedAt.toISOString(),
  };
}

function isLiveDelivery(delivery: Delivery, channel: Channel) {
  return TrackedItemModel.findOne({
    _id: delivery.trackedItemId,
    userId: delivery.userId,
    productId: delivery.productId,
    enabled: true,
    episodeOpen: true,
    episodeId: delivery.episodeId,
    [`alerts.${channel}`]: true,
  }).select('_id').lean().exec().then(Boolean);
}

async function loadLiveContext(delivery: Delivery, channel: Channel, freshAt?: Date): Promise<LiveContext | null> {
  const [tracker, user, product, observation] = await Promise.all([
    TrackedItemModel.findOne({
      _id: delivery.trackedItemId,
      userId: delivery.userId,
      productId: delivery.productId,
      enabled: true,
      episodeOpen: true,
      episodeId: delivery.episodeId,
      [`alerts.${channel}`]: true,
    }).select('targetPriceMinor currency').lean().exec(),
    UserModel.findOne({ _id: delivery.userId, emailVerifiedAt: { $ne: null } }).select('email').lean().exec(),
    ProductModel.findById(delivery.productId).lean().exec(),
    PriceHistoryModel.findOne({ _id: delivery.observationId, productId: delivery.productId })
      .select('priceMinor currency observedAt dealId source').lean().exec(),
  ]);
  if (!tracker || !user) return null;
  if ((!product || !observation) && freshAt) throw new FreshObservationUnavailable();
  if (!product || !observation || typeof user.email !== 'string' ||
      !Number.isSafeInteger(observation.priceMinor) || observation.priceMinor < 0 ||
      !Number.isSafeInteger(tracker.targetPriceMinor) || observation.priceMinor > tracker.targetPriceMinor ||
      tracker.currency !== 'USD' || product.currency !== 'USD' || observation.currency !== 'USD' ||
      observation.source !== 'CheapShark' || !(observation.observedAt instanceof Date) ||
      typeof observation.dealId !== 'string' || observation.dealId.length === 0 ||
      typeof product.title !== 'string' || product.title.trim().length === 0) return null;
  if (freshAt) {
    // First dispatch must represent a current recorded success. A temporary
    // failure or a concurrent new quote defers the same channel obligation.
    if (observation.observedAt > freshAt || observation.observedAt.getTime() + 86400000 <= freshAt.getTime() ||
        product.provider !== 'cheapshark' || product.storeId !== '1' || product.market !== 'US' ||
        product.lastError !== null || product.currentPriceMinor !== observation.priceMinor ||
        product.lastSuccessfulCheckAt?.getTime() !== observation.observedAt.getTime() ||
        product.dealId !== observation.dealId || !product.purchaseUrl ||
        product.purchaseUrl !== cheapSharkPurchaseUrl(observation.dealId)) throw new FreshObservationUnavailable();
    if (await PriceHistoryModel.exists({ productId: delivery.productId, $or: [
      { observedAt: { $gt: observation.observedAt } },
      { observedAt: observation.observedAt, _id: { $gt: delivery.observationId } },
    ] })) throw new FreshObservationUnavailable();
  }
  return {
    recipient: user.email,
    gameTitle: product.title,
    currentPriceCents: observation.priceMinor,
    targetPriceCents: tracker.targetPriceMinor,
    purchaseUrl: cheapSharkPurchaseUrl(observation.dealId),
    observedAt: observation.observedAt,
    productId: delivery.productId,
  };
}

function deliveryFilter(id: Types.ObjectId, leaseToken: string): mongoose.QueryFilter<DeliveryShape> {
  return { _id: id, status: 'sending', leaseToken };
}

function countStatus(result: AlertDeliveryBatchResult, status: DeliveryStatus | undefined) {
  if (status === 'sent') result.sent += 1;
  else if (status === 'retryable' || status === 'pending' || status === 'sending') result.retryable += 1;
  else if (status === 'permanent_failure') result.permanentFailure += 1;
  else if (status === 'unknown') result.unknown += 1;
  else if (status === 'cancelled') result.cancelled += 1;
}

function aggregatePushStatus(devices: PushRecipient[], now: Date): { status: DeliveryStatus; availableAt: Date } {
  const actionable = devices.filter(device => device.status === 'pending' || device.status === 'retryable');
  if (actionable.length > 0) {
    const availableAt = actionable.reduce((earliest, device) => device.availableAt < earliest ? device.availableAt : earliest, actionable[0]!.availableAt);
    return { status: 'retryable', availableAt: availableAt < now ? now : availableAt };
  }
  if (devices.some(device => device.status === 'sending')) return { status: 'sending', availableAt: now };
  if (devices.some(device => device.status === 'unknown')) return { status: 'unknown', availableAt: now };
  if (devices.some(device => device.status === 'accepted')) return { status: 'sent', availableAt: now };
  if (devices.length > 0 && devices.every(device => device.status === 'cancelled')) return { status: 'cancelled', availableAt: now };
  if (devices.some(device => device.status === 'permanent_failure')) return { status: 'permanent_failure', availableAt: now };
  return { status: 'permanent_failure', availableAt: now };
}

function report(onError: AlertDeliveryWorkerOptions['onError'], code: string) {
  try { onError?.(code); } catch { /* Reporting must not affect durable delivery state. */ }
}

/**
 * A database-backed, bounded alert outbox worker. Creation is inert: callers own
 * application lifecycle and must explicitly call start()/stop(). A batch claims
 * at most `batchSize` channel deliveries; retries and state are durable in MongoDB.
 */
export function createPriceAlertDeliveryWorker(options: AlertDeliveryWorkerOptions) {
  if (typeof options.pushSender !== 'function') throw new Error('A push sender is required.');
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) throw new Error('Invalid alert batch size.');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < MIN_POLL_INTERVAL_MS || pollIntervalMs > MAX_POLL_INTERVAL_MS) throw new Error('Invalid alert poll interval.');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) throw new Error('Invalid alert lease duration.');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) throw new Error('Invalid alert retry limit.');
  const now = options.now ?? (() => new Date());
  const emailSender = options.emailSender ?? sendPriceAlert;

  async function renewLease(delivery: Delivery): Promise<boolean> {
    if (!delivery.leaseToken) return false;
    const at = now();
    const result = await NotificationDeliveryModel.updateOne({
      ...deliveryFilter(delivery._id, delivery.leaseToken), leaseUntil: { $gt: at },
    }, { $set: { leaseUntil: new Date(at.getTime() + leaseMs) } }).exec();
    return result.matchedCount === 1;
  }

  async function finish(delivery: Delivery, status: DeliveryStatus, fields: Record<string, unknown> = {}) {
    if (!delivery.leaseToken) return false;
    const at = now();
    // Cancellation, local configuration errors and later definite rejections
    // cannot disprove an earlier acceptance. Keep that uncertainty durable.
    const uncertain = fields.emailUncertain ?? delivery.emailUncertain;
    if (delivery.channel === 'email' && uncertain === true && status !== 'sent') status = 'unknown';
    if (delivery.channel === 'email') fields.emailUncertain = status === 'sent' ? false : status === 'unknown' || uncertain === true;
    if (status === 'unknown' && fields.availableAt === undefined) {
      fields.availableAt = new Date(at.getTime() + retryDelayMs(delivery.attempts));
    }
    const result = await NotificationDeliveryModel.updateOne({
      ...deliveryFilter(delivery._id, delivery.leaseToken), leaseUntil: { $gt: at },
    }, { $set: { ...fields, status, leaseToken: null, leaseUntil: null } }).exec();
    return result.matchedCount === 1;
  }

  async function prepareFirstDispatch(delivery: Delivery): Promise<Delivery> {
    // Once a transport may have been called, its snapshot and key are immutable.
    if (delivery.firstAttemptAt || delivery.attempts !== 0) return delivery;
    if (!await isLiveDelivery(delivery, delivery.channel)) return delivery;
    const observation = await PriceHistoryModel.findOne({ productId: delivery.productId })
      .sort({ observedAt: -1, _id: -1 }).select('_id').lean().exec();
    if (!observation) throw new FreshObservationUnavailable();
    const updated = await NotificationDeliveryModel.findOneAndUpdate({
      ...deliveryFilter(delivery._id, delivery.leaseToken!), leaseUntil: { $gt: now() },
      firstAttemptAt: null, attempts: 0,
    }, { $set: { observationId: observation._id, emailPayload: null, idempotencyKey: null,
      pushPayload: null, pushDevices: null } }, { returnDocument: 'after' }).select(projection).lean<Delivery>().exec();
    return updated ?? delivery;
  }

  async function deferFreshObservation(delivery: Delivery) {
    const current = await NotificationDeliveryModel.findOne({
      ...deliveryFilter(delivery._id, delivery.leaseToken!), leaseUntil: { $gt: now() },
    }).select(projection).lean<Delivery>().exec();
    if (!current) return;
    const fields: Record<string, unknown> = {
      availableAt: new Date(now().getTime() + BASE_RETRY_DELAY_MS),
      lastErrorCode: 'AWAITING_FRESH_OBSERVATION',
    };
    if (current.channel === 'email') {
      // This error can only arise before the transport call on first dispatch.
      Object.assign(fields, { attempts: delivery.attempts, firstAttemptAt: null,
        emailUncertain: false, emailPayload: null, idempotencyKey: null });
    } else {
      // Freshness is checked immediately before each FCM call. Roll back only
      // the locally marked recipient whose transport has not been invoked.
      let restored = 0;
      const devices = current.pushDevices?.map(device => {
        if (device.status !== 'sending') return device;
        restored++;
        return { ...device, status: 'pending' as const, attempts: device.attempts - 1 };
      }) ?? null;
      const attempts = current.attempts - restored;
      Object.assign(fields, { attempts, pushDevices: devices });
      if (attempts === 0) Object.assign(fields, { firstAttemptAt: null, pushPayload: null, pushDevices: null });
    }
    await finish(current, 'retryable', fields);
  }

  async function recoverExpiredClaims(at: Date, limit: number) {
    const expired = await NotificationDeliveryModel.find({ status: 'sending', leaseUntil: { $lte: at } })
      .select(projection).sort({ leaseUntil: 1, _id: 1 }).limit(limit).lean<Delivery[]>().exec();
    for (const delivery of expired) {
      if (!delivery.leaseToken) continue;
      if (delivery.channel === 'email') {
        const status: DeliveryStatus = delivery.firstAttemptAt ? 'unknown' : 'retryable';
        await NotificationDeliveryModel.updateOne({
          ...deliveryFilter(delivery._id, delivery.leaseToken), leaseUntil: { $lte: at },
        }, { $set: { status, availableAt: at, leaseToken: null, leaseUntil: null,
          ...(status === 'unknown' ? { emailUncertain: true, lastErrorCode: 'EMAIL_CLAIM_EXPIRED_UNKNOWN' } : {}) } }).exec();
        continue;
      }
      const devices = (delivery.pushDevices ?? []).map(device => device.status === 'sending'
        ? { ...device, status: 'unknown' as const, lastErrorCode: 'FCM_CLAIM_EXPIRED_UNKNOWN' }
        : device);
      const aggregate = aggregatePushStatus(devices, at);
      await NotificationDeliveryModel.updateOne({
        ...deliveryFilter(delivery._id, delivery.leaseToken), leaseUntil: { $lte: at },
      }, { $set: {
        pushDevices: delivery.pushDevices === null ? null : devices,
        status: delivery.pushDevices === null ? 'retryable' : aggregate.status,
        availableAt: delivery.pushDevices === null ? at : aggregate.availableAt,
        leaseToken: null,
        leaseUntil: null,
        ...(devices.some(device => device.status === 'unknown') ? { lastErrorCode: 'FCM_CLAIM_EXPIRED_UNKNOWN' } : {}),
      } }).exec();
    }
  }

  async function expireUnsafeEmailRetries(at: Date, limit: number) {
    const cutoff = new Date(at.getTime() - EMAIL_RETRY_CUTOFF_MS);
    const expired = await NotificationDeliveryModel.find({
      channel: 'email', status: 'retryable', firstAttemptAt: { $lte: cutoff }, attempts: { $gt: 0 },
    }).select('_id emailUncertain').sort({ firstAttemptAt: 1, _id: 1 }).limit(limit).lean().exec();
    for (const delivery of expired) {
      await NotificationDeliveryModel.updateOne({
        _id: delivery._id, channel: 'email', status: 'retryable', firstAttemptAt: { $lte: cutoff },
      }, { $set: { status: delivery.emailUncertain ? 'unknown' : 'permanent_failure', lastErrorCode: 'RESEND_IDEMPOTENCY_WINDOW_EXPIRED' } }).exec();
    }
  }

  async function claim(at: Date): Promise<Delivery | null> {
    const cutoff = new Date(at.getTime() - EMAIL_RETRY_CUTOFF_MS);
    const emailFirstAttempt = {
      $or: [{ firstAttemptAt: null }, { firstAttemptAt: { $gt: cutoff } }],
    };
    const filter: mongoose.QueryFilter<DeliveryShape> = {
      availableAt: { $lte: at },
      $or: [
        { channel: 'push', status: { $in: ['pending', 'retryable'] } },
        { channel: 'email', status: { $in: ['pending', 'retryable'] }, attempts: { $lt: maxAttempts }, ...emailFirstAttempt },
        { channel: 'email', status: 'unknown', attempts: { $lt: maxAttempts }, firstAttemptAt: { $gt: cutoff } },
      ],
    };
    const leaseToken = randomUUID();
    const delivery = await NotificationDeliveryModel.findOneAndUpdate(filter, {
      $set: { status: 'sending', leaseToken, leaseUntil: new Date(at.getTime() + leaseMs) },
    }, { returnDocument: 'before', sort: { availableAt: 1, createdAt: 1, _id: 1 }, runValidators: true })
      .select(projection).lean<Delivery>().exec();
    if (!delivery) return null;
    return { ...delivery, leaseToken, leaseUntil: new Date(at.getTime() + leaseMs),
      emailUncertain: delivery.emailUncertain || (delivery.channel === 'email' && delivery.status === 'unknown') };
  }

  async function markEmailStart(delivery: Delivery, snapshot: EmailSnapshot, key: string): Promise<Delivery | null> {
    if (!delivery.leaseToken) return null;
    const at = now();
    const firstAttemptAt = delivery.firstAttemptAt ?? at;
    const result = await NotificationDeliveryModel.findOneAndUpdate({
      ...deliveryFilter(delivery._id, delivery.leaseToken), leaseUntil: { $gt: at },
    }, {
      $set: {
        ...(delivery.emailPayload ? {} : { emailPayload: snapshot }),
        ...(delivery.idempotencyKey ? {} : { idempotencyKey: key }),
        firstAttemptAt,
        emailUncertain: true,
        leaseUntil: new Date(at.getTime() + leaseMs),
      },
      $inc: { attempts: 1 },
    }, { new: true, runValidators: true }).select(projection).lean<Delivery>().exec();
    return result;
  }

  async function processEmail(delivery: Delivery): Promise<void> {
    const wasUnknown = delivery.emailUncertain;
    const firstDispatch = !delivery.firstAttemptAt;
    const context = await loadLiveContext(delivery, 'email', firstDispatch ? now() : undefined);
    if (!context) { await finish(delivery, 'cancelled', { lastErrorCode: 'DELIVERY_NO_LONGER_ELIGIBLE' }); return; }

    let snapshot: EmailSnapshot;
    let key: string;
    if (delivery.emailPayload && delivery.idempotencyKey && delivery.firstAttemptAt) {
      snapshot = delivery.emailPayload;
      key = delivery.idempotencyKey;
    } else if (!delivery.emailPayload && !delivery.idempotencyKey && !delivery.firstAttemptAt) {
      snapshot = makeEmailSnapshot(context);
      key = `price-alert-${idString(delivery._id)}`;
    } else {
      await finish(delivery, 'unknown', { lastErrorCode: 'EMAIL_SNAPSHOT_INCOMPLETE' });
      return;
    }

    if (delivery.firstAttemptAt && !emailRetryIsSafe(delivery.firstAttemptAt, now())) {
      if (wasUnknown) {
        await finish(delivery, 'unknown', { availableAt: emailRetryCutoff(delivery.firstAttemptAt), lastErrorCode: 'RESEND_IDEMPOTENCY_WINDOW_EXPIRED' });
      } else {
        await finish(delivery, 'permanent_failure', { lastErrorCode: 'RESEND_IDEMPOTENCY_WINDOW_EXPIRED' });
      }
      return;
    }

    if (snapshot.recipient !== context.recipient) {
      await finish(delivery, 'cancelled', { lastErrorCode: 'EMAIL_RECIPIENT_CHANGED' });
      return;
    }
    const started = await markEmailStart(delivery, snapshot, key);
    if (!started?.leaseToken || !started.emailPayload || !started.idempotencyKey || !started.firstAttemptAt) return;
    if (started.emailPayload.recipient !== snapshot.recipient || started.idempotencyKey !== key) {
      await finish(started, 'unknown', { lastErrorCode: 'EMAIL_SNAPSHOT_CONFLICT' });
      return;
    }

    if (!await renewLease(started)) return;
    const live = await loadLiveContext(started, 'email', firstDispatch ? now() : undefined);
    if (!live || live.recipient !== started.emailPayload.recipient) {
      await finish(started, 'cancelled', { emailUncertain: wasUnknown, lastErrorCode: 'DELIVERY_NO_LONGER_ELIGIBLE' });
      return;
    }
    if (started.attempts > 1 && !emailRetryIsSafe(started.firstAttemptAt, now())) {
      await finish(started, wasUnknown ? 'unknown' : 'permanent_failure', {
        lastErrorCode: 'RESEND_IDEMPOTENCY_WINDOW_EXPIRED',
      });
      return;
    }
    let outcome: DeliveryOutcome;
    try {
      const { recipient, ...alert } = started.emailPayload;
      outcome = await emailSender(recipient, alert, started.idempotencyKey);
    } catch (error) {
      if (error instanceof EmailSendDeferred) {
        await finish(started, wasUnknown ? 'unknown' : 'pending', {
          attempts: delivery.attempts, firstAttemptAt: delivery.firstAttemptAt,
          emailUncertain: wasUnknown, emailPayload: delivery.emailPayload, idempotencyKey: delivery.idempotencyKey,
          availableAt: new Date(now().getTime() + Math.max(1000, error.retryAfterMs)), lastErrorCode: 'EMAIL_BUDGET_DEFERRED',
        });
        return;
      }
      outcome = { status: 'unknown', code: 'EMAIL_SEND_OUTCOME_UNKNOWN', attempts: 1 };
    }

    const at = now();
    const attemptNumber = started.attempts;
    if (outcome.status === 'success') {
      await finish(started, 'sent', { emailUncertain: false, providerMessageId: outcome.messageId, sentAt: at, lastErrorCode: null });
    } else if (outcome.status === 'permanent_failure') {
      await finish(started, 'permanent_failure', { emailUncertain: wasUnknown,
        availableAt: new Date(at.getTime() + retryDelayMs(attemptNumber)), lastErrorCode: safeCode(outcome.code) });
    } else if (outcome.status === 'retryable_failure' && attemptNumber >= maxAttempts) {
      await finish(started, 'permanent_failure', { emailUncertain: wasUnknown, lastErrorCode: 'DELIVERY_RETRY_LIMIT_REACHED' });
    } else {
      const delay = retryDelayMs(attemptNumber, outcome.retryAfterMs);
      await finish(started, outcome.status === 'retryable_failure' ? 'retryable' : 'unknown', {
        emailUncertain: wasUnknown || outcome.status === 'unknown',
        availableAt: new Date(at.getTime() + delay),
        lastErrorCode: safeCode(outcome.code),
      });
    }
  }

  async function initializePushSnapshot(delivery: Delivery): Promise<Delivery | null> {
    if (!delivery.leaseToken) return null;
    const context = await loadLiveContext(delivery, 'push', !delivery.firstAttemptAt ? now() : undefined);
    if (!context) {
      await finish(delivery, 'cancelled', { lastErrorCode: 'DELIVERY_NO_LONGER_ELIGIBLE' });
      return null;
    }
    const existingPayload = delivery.pushPayload;
    const existingDevices = delivery.pushDevices;
    if (existingPayload && existingDevices !== null) return delivery;
    if (existingPayload || existingDevices !== null || delivery.firstAttemptAt) {
      await finish(delivery, 'unknown', { lastErrorCode: 'FCM_SNAPSHOT_INCOMPLETE' });
      return null;
    }

    const devices = await eligiblePushDevices(idString(delivery.userId), now());
    const recipients: PushRecipient[] = devices
      .filter(device => typeof device.pushToken === 'string' && device.pushToken.length > 0 && isObjectId(device._id) && isObjectId(device.sessionId))
      .sort((a, b) => idString(a._id).localeCompare(idString(b._id)))
      .map(device => ({
        deviceId: device._id,
        sessionId: device.sessionId,
        tokenHash: tokenDigest(device.pushToken),
        status: 'pending',
        attempts: 0,
        availableAt: now(),
        providerMessageId: null,
        lastErrorCode: null,
      }));
    const payload = makePushSnapshot(delivery, context);
    const at = now();
    if (recipients.length === 0) {
      await finish(delivery, 'permanent_failure', { pushPayload: payload, pushDevices: [], availableAt: at, lastErrorCode: 'FCM_NO_ELIGIBLE_DEVICE' });
      return null;
    }
    return NotificationDeliveryModel.findOneAndUpdate({
      ...deliveryFilter(delivery._id, delivery.leaseToken), leaseUntil: { $gt: at }, pushDevices: null, pushPayload: null,
    }, { $set: { pushPayload: payload, pushDevices: recipients } }, { new: true, runValidators: true })
      .select(projection).lean<Delivery>().exec();
  }

  async function updatePushRecipient(
    delivery: Delivery,
    index: number,
    expectedStatus: RecipientStatus,
    status: RecipientStatus,
    fields: Record<string, unknown> = {},
    incrementAttempt = false,
  ): Promise<boolean> {
    if (!delivery.leaseToken) return false;
    const at = now();
    const path = `pushDevices.${index}`;
    const update: Record<string, unknown> = {
      $set: { [`${path}.status`]: status,
        ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${path}.${key}`, value])),
      },
    };
    if (incrementAttempt) update.$inc = { attempts: 1, [`${path}.attempts`]: 1 };
    const result = await NotificationDeliveryModel.updateOne({
      ...deliveryFilter(delivery._id, delivery.leaseToken),
      leaseUntil: { $gt: at },
      [`${path}.status`]: expectedStatus,
    }, update, { runValidators: true }).exec();
    return result.matchedCount === 1;
  }

  async function eligibleRecipient(delivery: Delivery, recipient: PushRecipient) {
    if (!await isLiveDelivery(delivery, 'push')) return null;
    const devices = await eligiblePushDevices(idString(delivery.userId), now());
    return devices.find(device => idString(device._id) === idString(recipient.deviceId) &&
      idString(device.sessionId) === idString(recipient.sessionId) && typeof device.pushToken === 'string') ?? null;
  }

  async function processPush(delivery: Delivery): Promise<void> {
    const initialized = await initializePushSnapshot(delivery);
    if (!initialized) return;
    if (!initialized.leaseToken || !initialized.pushPayload || !initialized.pushDevices) {
      await finish(initialized, 'unknown', { lastErrorCode: 'FCM_SNAPSHOT_INCOMPLETE' });
      return;
    }

    const eventBase = initialized.pushPayload;
    for (let index = 0; index < initialized.pushDevices.length; index += 1) {
      const recipient = initialized.pushDevices[index]!;
      if (recipient.status !== 'pending' && recipient.status !== 'retryable') continue;
      const at = now();
      if (recipient.availableAt > at) continue;
      if (recipient.attempts >= maxAttempts) {
        await updatePushRecipient(initialized, index, recipient.status, 'permanent_failure', { lastErrorCode: 'DELIVERY_RETRY_LIMIT_REACHED' });
        continue;
      }
      if (!await renewLease(initialized)) return;
      const currentDevice = await eligibleRecipient(initialized, recipient);
      if (!currentDevice) {
        await updatePushRecipient(initialized, index, recipient.status, 'cancelled', { lastErrorCode: 'DEVICE_NO_LONGER_ELIGIBLE' });
        continue;
      }
      const currentTokenHash = tokenDigest(currentDevice.pushToken);
      const marked = await updatePushRecipient(initialized, index, recipient.status, 'sending', {
        tokenHash: currentTokenHash,
        availableAt: at,
        lastErrorCode: null,
      }, true);
      if (!marked) return;
      await NotificationDeliveryModel.updateOne({
        ...deliveryFilter(initialized._id, initialized.leaseToken), leaseUntil: { $gt: now() }, firstAttemptAt: null,
      }, {
        $set: { firstAttemptAt: at },
      }).exec();
      // Revalidate ownership, verification, tracker settings and the fence directly
      // before the external call. MongoDB cannot make that check atomic with FCM.
      if (!await renewLease(initialized)) return;
      const finalDevice = await eligibleRecipient(initialized, recipient);
      if (!finalDevice || tokenDigest(finalDevice.pushToken) !== currentTokenHash ||
          (!initialized.firstAttemptAt && !await loadLiveContext(initialized, 'push', now()))) {
        await updatePushRecipient(initialized, index, 'sending', 'cancelled', { lastErrorCode: 'DEVICE_NO_LONGER_ELIGIBLE' });
        continue;
      }
      const parsedEvent = pushEventSchema.safeParse({ ...eventBase, recipientSessionId: idString(recipient.sessionId) });
      if (!parsedEvent.success) {
        await updatePushRecipient(initialized, index, 'sending', 'permanent_failure', { lastErrorCode: 'FCM_INVALID_EVENT' });
        continue;
      }

      let outcome: PushOutcome;
      try {
        outcome = await options.pushSender(finalDevice.pushToken, parsedEvent.data);
      } catch {
        outcome = { kind: 'unknown', code: 'FCM_SEND_OUTCOME_UNKNOWN' };
      }

      const outcomeAt = now();
      if (outcome.kind === 'accepted') {
        await updatePushRecipient(initialized, index, 'sending', 'accepted', {
          providerMessageId: outcome.providerMessageId,
          lastErrorCode: null,
        });
      } else if (outcome.kind === 'permanent_failure') {
        if (outcome.invalidToken) {
          try {
            await deactivateInvalidDevice(idString(currentDevice._id), idString(currentDevice.sessionId), finalDevice.pushToken);
          } catch {
            report(options.onError, 'FCM_INVALID_TOKEN_CLEANUP_FAILED');
          }
        }
        await updatePushRecipient(initialized, index, 'sending', 'permanent_failure', { lastErrorCode: safeCode(outcome.code) });
      } else if (outcome.kind === 'retryable' && recipient.attempts + 1 < maxAttempts) {
        await updatePushRecipient(initialized, index, 'sending', 'retryable', {
          availableAt: new Date(outcomeAt.getTime() + retryDelayMs(recipient.attempts + 1, outcome.retryAfterSeconds * 1000)),
          lastErrorCode: safeCode(outcome.code),
        });
      } else if (outcome.kind === 'retryable') {
        await updatePushRecipient(initialized, index, 'sending', 'permanent_failure', { lastErrorCode: 'DELIVERY_RETRY_LIMIT_REACHED' });
      } else {
        // FCM has no idempotency guarantee; uncertain sends are terminal per device.
        await updatePushRecipient(initialized, index, 'sending', 'unknown', { lastErrorCode: safeCode(outcome.code) });
      }
    }

    const current = await NotificationDeliveryModel.findOne({
      ...deliveryFilter(initialized._id, initialized.leaseToken), leaseUntil: { $gt: now() },
    })
      .select(projection).lean<Delivery>().exec();
    if (!current?.leaseToken || !current.pushDevices) return;
    const at = now();
    const aggregate = aggregatePushStatus(current.pushDevices, at);
    await finish(current, aggregate.status, {
      availableAt: aggregate.availableAt,
      ...(aggregate.status === 'sent' ? {
        providerMessageId: current.pushDevices.find(device => device.status === 'accepted')?.providerMessageId ?? null,
        sentAt: at,
        lastErrorCode: null,
      } : aggregate.status === 'unknown' ? { lastErrorCode: 'FCM_OUTCOME_UNKNOWN' } : {}),
    });
  }

  async function process(delivery: Delivery) {
    try {
      const prepared = await prepareFirstDispatch(delivery);
      if (prepared.channel === 'email') await processEmail(prepared);
      else await processPush(prepared);
    } catch (error) {
      if (!(error instanceof FreshObservationUnavailable)) throw error;
      await deferFreshObservation(delivery);
    }
  }

  async function runBatch(shouldStop: () => boolean = () => false): Promise<AlertDeliveryBatchResult> {
    const result: AlertDeliveryBatchResult = { claimed: 0, sent: 0, retryable: 0, permanentFailure: 0, unknown: 0, cancelled: 0 };
    const startedAt = now();
    await expireUnsafeEmailRetries(startedAt, batchSize);
    await recoverExpiredClaims(startedAt, batchSize);
    for (let index = 0; index < batchSize && !shouldStop(); index += 1) {
      const delivery = await claim(now());
      if (!delivery) break;
      result.claimed += 1;
      try {
        await process(delivery);
      } catch {
        // Leave the fenced claim for lease recovery. If an external call had begun,
        // recovery marks it uncertain rather than assuming non-delivery.
        report(options.onError, 'ALERT_DELIVERY_ITEM_FAILED');
      }
      const settled = await NotificationDeliveryModel.findById(delivery._id).select('status').lean().exec();
      countStatus(result, settled?.status as DeliveryStatus | undefined);
    }
    return result;
  }

  let stopped = true;
  let loopPromise: Promise<void> | null = null;
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveDelay: (() => void) | null = null;

  async function loop() {
    while (!stopped) {
      let batch: AlertDeliveryBatchResult | undefined;
      try { batch = await runBatch(() => stopped); }
      catch { report(options.onError, 'ALERT_DELIVERY_BATCH_FAILED'); }
      if (stopped) break;
      if (batch?.claimed === batchSize) continue;
      await new Promise<void>(resolve => {
        resolveDelay = resolve;
        delayTimer = setTimeout(() => {
          delayTimer = null;
          resolveDelay = null;
          resolve();
        }, pollIntervalMs);
        delayTimer.unref?.();
      });
    }
  }

  return {
    runBatch: () => runBatch(),
    start() {
      if (loopPromise) return;
      stopped = false;
      loopPromise = loop().finally(() => { loopPromise = null; });
    },
    async stop() {
      stopped = true;
      if (delayTimer) clearTimeout(delayTimer);
      delayTimer = null;
      resolveDelay?.();
      resolveDelay = null;
      await loopPromise;
    },
  };
}
