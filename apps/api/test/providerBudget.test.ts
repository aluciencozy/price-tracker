import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Budget = {
  leaseUntil: Date;
  leaseToken: string | null;
  nextRequestAt: Date;
  cooldownUntil: Date;
  rateLimitCount: number;
};
type Filter = {
  leaseToken?: string;
  leaseUntil?: { $lte: Date };
  nextRequestAt?: { $lte: Date };
  cooldownUntil?: { $lte: Date };
};
type Update = {
  $set?: Partial<Budget>;
  $max?: Partial<Pick<Budget, 'nextRequestAt' | 'cooldownUntil'>>;
  $inc?: { rateLimitCount: number };
};

const mocks = vi.hoisted(() => ({ updateOne: vi.fn(), findOneAndUpdate: vi.fn(), findById: vi.fn() }));
vi.mock('../src/models/providerBudget.js', () => ({ ProviderBudgetModel: mocks }));
// Route promise-based sleeps through Vitest's fake clock as well.
vi.mock('node:timers/promises', () => ({
  setTimeout: (milliseconds: number, _value: unknown, options?: { signal?: AbortSignal }) => new Promise<void>((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  }),
}));

import { ProviderDeferredError, ProviderRateLimitError, withCheapSharkRequestBudget } from '../src/providerBudget.js';

let budget: Budget;
function query<T>(value: T) {
  const result = { setOptions: (_options: unknown) => result, lean: () => ({ exec: async () => value }), exec: async () => value };
  return result;
}
function matches(filter: Filter): boolean {
  return (filter.leaseToken === undefined || budget.leaseToken === filter.leaseToken) &&
    (['leaseUntil', 'nextRequestAt', 'cooldownUntil'] as const).every(
      key => !filter[key] || budget[key] <= filter[key].$lte,
    );
}
function apply(update: Update) {
  Object.assign(budget, update.$set);
  if (update.$inc) budget.rateLimitCount += update.$inc.rateLimitCount;
  for (const key of ['nextRequestAt', 'cooldownUntil'] as const) {
    const value = update.$max?.[key];
    if (value && value > budget[key]) budget[key] = value;
  }
}
function pendingRequest() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const request = vi.fn(() => promise);
  return { request, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
  budget = { leaseUntil: new Date(0), leaseToken: null, nextRequestAt: new Date(0), cooldownUntil: new Date(0), rateLimitCount: 0 };
  mocks.updateOne.mockImplementation((filter: Filter, update: Update) => {
    const eligible = matches(filter);
    if (eligible) apply(update);
    return query({ modifiedCount: eligible ? 1 : 0 });
  });
  mocks.findOneAndUpdate.mockImplementation((filter: Filter, update: Update) => {
    if (!matches(filter)) return query(null);
    apply(update);
    return query({ ...budget });
  });
  mocks.findById.mockImplementation(() => query({ ...budget }));
});
afterEach(() => vi.useRealTimers());

describe('shared CheapShark request budget', () => {
  it('releases its own lease and paces the next request', async () => {
    await withCheapSharkRequestBudget(Date.now() + 30_000, async () => 'ok');
    expect(budget.leaseToken).toBeNull();
    expect(budget.leaseUntil).toEqual(new Date(0));
    const request = vi.fn(async () => 'next');
    const next = withCheapSharkRequestBudget(Date.now() + 30_000, request);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toBe('next');
  });

  it.each(['success', 'failure', 'rate limit'] as const)(
    'does not release a replacement lease after an expired owner reports %s',
    async outcome => {
      const first = pendingRequest();
      const replacement = pendingRequest();
      const a = withCheapSharkRequestBudget(Date.now() + 60_000, first.request);
      // Attach a rejection handler before resolving/rejecting the request below.
      const result = a.catch(error => error);
      await vi.waitFor(() => expect(first.request).toHaveBeenCalledOnce());
      const firstToken = budget.leaseToken;
      await vi.advanceTimersByTimeAsync(15_001);
      const b = withCheapSharkRequestBudget(Date.now() + 60_000, replacement.request);
      await vi.waitFor(() => expect(replacement.request).toHaveBeenCalledOnce());
      const replacementToken = budget.leaseToken;
      const replacementExpiry = budget.leaseUntil;
      expect(replacementToken).not.toBe(firstToken);
      budget.rateLimitCount = 2;

      if (outcome === 'success') first.resolve();
      else if (outcome === 'failure') first.reject(new Error('network failed'));
      else first.reject(new ProviderRateLimitError(null, '120'));
      await result;

      expect(budget.leaseToken).toBe(replacementToken);
      expect(budget.leaseUntil).toEqual(replacementExpiry);
      if (outcome === 'rate limit') {
        expect(budget.cooldownUntil.getTime()).toBe(Date.now() + 120_000);
      } else {
        expect(budget.rateLimitCount).toBe(2);
      }
      replacement.resolve();
      await b;
      expect(budget.leaseToken).toBeNull();
      if (outcome === 'rate limit') {
        // A later successful release must not shorten the stored cooldown.
        expect(budget.nextRequestAt).toEqual(budget.cooldownUntil);
      }
    },
  );

  it('persists Retry-After and defers requests beyond their lookup deadline', async () => {
    const retryAt = new Date(Date.now() + 120_000);
    await expect(withCheapSharkRequestBudget(Date.now() + 30_000, async () => {
      throw new ProviderRateLimitError(null, '120');
    })).rejects.toMatchObject({ name: 'ProviderRateLimitError', retryAt });
    expect(budget.cooldownUntil).toEqual(retryAt);
    expect(budget.nextRequestAt).toEqual(retryAt);
    expect(budget.leaseToken).toBeNull();
    const request = vi.fn();
    await expect(withCheapSharkRequestBudget(Date.now() + 30_000, request)).rejects.toBeInstanceOf(ProviderDeferredError);
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels while waiting for the shared request slot without making an outbound request', async () => {
    budget.nextRequestAt = new Date(Date.now() + 5_000);
    const controller = new AbortController();
    const request = vi.fn(async () => undefined);
    const pending = withCheapSharkRequestBudget(Date.now() + 10_000, request, controller.signal);
    await vi.waitFor(() => expect(mocks.findById).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
    expect(budget.leaseToken).toBeNull();
    const claimsAfterAbort = mocks.findOneAndUpdate.mock.calls.length;
    const readsAfterAbort = mocks.findById.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(claimsAfterAbort);
    expect(mocks.findById).toHaveBeenCalledTimes(readsAfterAbort);
  });

  it('releases an aborted in-flight slot but keeps the next provider request paced', async () => {
    const controller = new AbortController();
    const request = vi.fn(() => new Promise<void>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    }));
    const first = withCheapSharkRequestBudget(Date.now() + 30_000, request, controller.signal);
    const firstResult = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.abort();
    await firstResult;
    expect(budget.leaseToken).toBeNull();

    const nextRequest = vi.fn(async () => 'paced');
    const next = withCheapSharkRequestBudget(Date.now() + 30_000, nextRequest);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(nextRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toBe('paced');
    expect(nextRequest).toHaveBeenCalledOnce();
  });
});
