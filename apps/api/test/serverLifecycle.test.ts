import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const server = { on: vi.fn(), close: vi.fn((done: () => void) => done()) };
  return {
    server,
    listen: vi.fn(() => server),
    connect: vi.fn(async () => {}), indexes: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    stopWorkers: vi.fn(async () => {}), stopChecks: vi.fn(async () => {}), startWorkers: vi.fn(),
  };
});
vi.mock('../src/app.js', () => ({ createApp: () => ({ listen: fixture.listen }) }));
vi.mock('../src/config.js', () => ({ loadConfig: () => ({ PORT: 4000, HOST: '127.0.0.1', MONGODB_URI: 'fixture', PRICE_TRACKING_ENABLED: false }) }));
vi.mock('../src/database.js', () => ({ connectDatabase: fixture.connect, disconnectDatabase: fixture.disconnect, databaseStatus: () => 'connected' }));
vi.mock('../src/models/index.js', () => ({ createDatabaseIndexes: fixture.indexes }));
vi.mock('../src/managedPriceChecks.js', () => ({ createManagedPriceChecks: () => ({ run: vi.fn(), resume: vi.fn(), stop: fixture.stopChecks }) }));
vi.mock('../src/backgroundWorkers.js', () => ({ startBackgroundWorkers: fixture.startWorkers }));
vi.mock('../src/productPreviewResolver.js', () => ({ resolveApprovedProductPreview: vi.fn() }));

describe('server startup and shutdown order', () => {
  const signals = new Map<string, () => void>();
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    signals.clear();
    exitCode = process.exitCode;
    fixture.startWorkers.mockReturnValue(fixture.stopWorkers);
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => { signals.set(event, listener); return process; }) as typeof process.on);
  });
  afterEach(() => { process.exitCode = exitCode; vi.restoreAllMocks(); vi.useRealTimers(); });

  it('waits for indexes, then drains workers and managed checks before disconnecting', async () => {
    let releaseIndexes!: () => void, releaseWorkers!: () => void, releaseChecks!: () => void;
    fixture.indexes.mockImplementationOnce(() => new Promise<void>(resolve => { releaseIndexes = resolve; }));
    fixture.stopWorkers.mockImplementationOnce(() => new Promise<void>(resolve => { releaseWorkers = resolve; }));
    fixture.stopChecks.mockImplementationOnce(() => new Promise<void>(resolve => { releaseChecks = resolve; }));
    await import('../src/server.js');
    await vi.waitFor(() => expect(fixture.indexes).toHaveBeenCalledTimes(1));
    expect(fixture.startWorkers).not.toHaveBeenCalled();
    releaseIndexes();
    await vi.waitFor(() => expect(fixture.startWorkers).toHaveBeenCalledTimes(1));
    const ready = fixture.startWorkers.mock.calls[0]![1] as () => boolean;
    expect(ready()).toBe(true);
    signals.get('SIGTERM')!();
    expect(ready()).toBe(false);
    expect(fixture.disconnect).not.toHaveBeenCalled();
    releaseWorkers();
    await Promise.resolve();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    releaseChecks();
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledTimes(1));
    signals.get('SIGINT')!();
    expect(fixture.server.close).toHaveBeenCalledTimes(1);
  });

  it('drains a connection still starting and never starts workers after shutdown', async () => {
    let releaseConnect!: () => void;
    fixture.connect.mockImplementationOnce(() => new Promise<void>(resolve => { releaseConnect = resolve; }));
    await import('../src/server.js');
    signals.get('SIGTERM')!();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    releaseConnect();
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledTimes(1));
    expect(fixture.indexes).not.toHaveBeenCalled();
    expect(fixture.startWorkers).not.toHaveBeenCalled();
  });

  it('never starts workers after index failure and reports no raw connection details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fixture.indexes.mockRejectedValueOnce(new Error('fixture secret connection string'));
    await import('../src/server.js');
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log.mock.calls[0]).toEqual(['Database, indexes or worker setup failed; /api/ready will report unavailable.']);
    expect(fixture.startWorkers).not.toHaveBeenCalled();
    signals.get('SIGTERM')!();
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledTimes(1));
  });

  it('stops background work after a listen error and preserves the unsuccessful exit code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../src/server.js');
    await vi.waitFor(() => expect(fixture.startWorkers).toHaveBeenCalledTimes(1));
    const onError = fixture.server.on.mock.calls.find(([event]) => event === 'error')![1] as () => void;
    onError();
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledTimes(1));
    expect(fixture.stopWorkers).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
