import * as dto from './dto';
import { ClientError, createHttp, type HttpOptions, type RequestOptions } from './http';

export type Session =
  | { status: 'unknown' | 'anonymous'; user: null; sessionId: null; expiresAt: null }
  | { status: 'authenticated'; user: dto.User; sessionId: string | null; expiresAt: string | null };
export type PageQuery = { limit?: number; cursor?: string };
export type WatchlistQuery = PageQuery & { q?: string };
export type HistoryQuery = PageQuery & { from?: string; to?: string };
type Csrf = { token: string; expiresAt: number };

function input<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new ClientError('invalid-input', 'Invalid request values.'); }
}
function idPath(id: string): string { return input(() => encodeURIComponent(dto.id(id))); }
function ownedTracker(id: string) {
  return (value: unknown) => {
    const item = dto.trackedItem(value);
    if (item.id !== id) throw new Error('Mismatched tracker.');
    return item;
  };
}
function queryString(value: WatchlistQuery | HistoryQuery, history = false): string {
  return input(() => {
    const query = dto.object(value, history ? ['limit', 'cursor', 'from', 'to'] : ['limit', 'cursor', 'q']);
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(dto.integer(query.limit, 1, 100)));
    if (query.cursor !== undefined) params.set('cursor', dto.text(query.cursor));
    if (query.q !== undefined) params.set('q', dto.text(query.q, 100));
    if (query.from !== undefined) params.set('from', dto.timestamp(query.from));
    if (query.to !== undefined) params.set('to', dto.timestamp(query.to));
    if (query.from !== undefined && query.to !== undefined) dto.historyWindow({ from: query.from, to: query.to });
    return params.size ? `?${params}` : '';
  });
}
function credentials(value: unknown, register = false) {
  const data = dto.object(value, register ? ['email', 'password', 'name'] : ['email', 'password']);
  return {
    email: dto.email(data.email), password: dto.text(data.password, 128, register ? 12 : 1),
    ...(register && data.name !== undefined ? { name: dto.text(data.name, 100) } : {}),
  };
}
function cancelled(): ClientError { return new ClientError('aborted', 'Session changed or request cancelled.'); }
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Construction does no I/O. Only explicit API mode should create/use this client.
export class WebClient {
  private readonly request;
  private session: Session = { status: 'unknown', user: null, sessionId: null, expiresAt: null };
  private readonly listeners = new Set<() => void>();
  private context = 0;
  private csrf: Csrf | undefined;
  private csrfFlight: Promise<Csrf> | undefined;

  constructor(options: HttpOptions = {}) { this.request = createHttp(options); }
  getSession = (): Session => this.session;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private setSession(session: Session) {
    this.session = session;
    for (const listener of this.listeners) listener();
  }
  private resetContext() {
    this.context++;
    this.csrf = undefined;
    this.csrfFlight = undefined;
  }
  private clearSession() {
    this.resetContext();
    this.setSession({ status: 'anonymous', user: null, sessionId: null, expiresAt: null });
  }
  private assertContext(context: number) { if (context !== this.context) throw cancelled(); }
  private async send<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, status: number,
    parse: (value: unknown) => T, options: RequestOptions & { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const context = this.context;
    let failureContext = context;
    try {
      return await this.request(method, path, status, parse, {
        ...options, onUnauthorized: () => {
          if (context === this.context) { this.clearSession(); failureContext = this.context; }
        },
      });
    } catch (error) {
      this.assertContext(failureContext);
      if (context === this.context && error instanceof ClientError && error.details.code === 'CSRF_INVALID') this.csrf = undefined;
      throw error;
    }
  }
  private getCsrf(): Promise<Csrf> {
    if (this.csrf && this.csrf.expiresAt > Date.now()) return Promise.resolve(this.csrf);
    if (this.csrfFlight) return this.csrfFlight;
    const context = this.context;
    const pending = this.send('GET', '/auth/web/csrf', 200, (value) => {
      const data = dto.object(value, ['csrfToken', 'expiresAt']);
      const token = dto.secret(data.csrfToken), expiresAt = Date.parse(dto.timestamp(data.expiresAt));
      if (expiresAt <= Date.now()) throw new Error('Expired CSRF token.');
      return { token, expiresAt };
    }).then((csrf) => {
      this.assertContext(context);
      this.csrf = csrf;
      return csrf;
    }).finally(() => { if (this.csrfFlight === pending) this.csrfFlight = undefined; });
    this.csrfFlight = pending;
    return pending;
  }
  private async read<T>(path: string, parse: (value: unknown) => T, options: RequestOptions): Promise<T> {
    const context = this.context;
    const result = await this.send('GET', path, 200, parse, options);
    this.assertContext(context);
    return result;
  }
  private async mutate<T>(
    method: 'POST' | 'PATCH' | 'DELETE', path: string, status: number, body: unknown,
    parse: (value: unknown) => T, options: RequestOptions, headers: Record<string, string> = {},
  ): Promise<T> {
    const context = this.context;
    if (options.signal?.aborted) throw cancelled();
    const csrf = await waitFor(this.getCsrf(), options.signal);
    this.assertContext(context);
    const result = await this.send(method, path, status, parse, { ...options, body, headers: { ...headers, 'X-CSRF-Token': csrf.token } });
    this.assertContext(context);
    return result;
  }

  async restoreSession(options: RequestOptions = {}): Promise<dto.User | null> {
    const context = this.context;
    try {
      const user = await this.read('/auth/web/me', dto.user, options);
      this.assertContext(context);
      if (this.session.status !== 'authenticated' || this.session.user.id !== user.id) this.resetContext();
      this.setSession({ status: 'authenticated', user, sessionId: null, expiresAt: null });
      return user;
    } catch (error) {
      if (error instanceof ClientError && error.details.status === 401) {
        if (this.session.status === 'anonymous') return null;
        throw cancelled();
      }
      // Offline/invalid JSON is not proof of an expired cookie. Keep the known state.
      throw error;
    }
  }
  async login(values: { email: string; password: string }, options: RequestOptions = {}): Promise<dto.WebLogin> {
    const body = input(() => credentials(values));
    this.resetContext();
    const context = this.context;
    const result = await this.mutate('POST', '/auth/web/login', 200, body, dto.webLogin, options);
    this.assertContext(context);
    this.resetContext();
    const loggedInContext = this.context;
    this.setSession({ status: 'authenticated', ...result });
    await waitFor(this.getCsrf(), options.signal);
    this.assertContext(loggedInContext);
    return result;
  }
  async logout(options: RequestOptions = {}): Promise<void> {
    const context = this.context;
    await this.mutate('POST', '/auth/web/logout', 204, undefined, () => undefined, options);
    this.assertContext(context);
    this.clearSession();
    await waitFor(this.getCsrf(), options.signal);
  }
  register(values: { email: string; password: string; name?: string }, options: RequestOptions = {}): Promise<dto.Accepted> {
    return this.mutate('POST', '/auth/web/register', 202, input(() => credentials(values, true)), dto.accepted, options);
  }
  resendVerification(email: string, options: RequestOptions = {}): Promise<dto.Accepted> {
    return this.mutate('POST', '/auth/web/resend-verification', 202, input(() => ({ email: dto.email(email) })), dto.accepted, options);
  }
  forgotPassword(email: string, options: RequestOptions = {}): Promise<dto.Accepted> {
    return this.mutate('POST', '/auth/web/forgot-password', 202, input(() => ({ email: dto.email(email) })), dto.accepted, options);
  }
  verifyEmail(token: string, options: RequestOptions = {}): Promise<void> {
    return this.mutate('POST', '/auth/web/verify-email', 204, input(() => ({ token: dto.secret(token) })), () => undefined, options);
  }
  async resetPassword(token: string, password: string, options: RequestOptions = {}): Promise<void> {
    const context = this.context;
    const body = input(() => ({ token: dto.secret(token), password: dto.text(password, 128, 12) }));
    await this.mutate('POST', '/auth/web/reset-password', 204, body, () => undefined, options);
    this.assertContext(context);
    this.clearSession();
  }
  preview(url: string, options: RequestOptions = {}): Promise<dto.Preview> {
    return this.mutate('POST', '/product-previews', 201, input(() => ({ url: dto.text(url) })), dto.preview, options);
  }
  listTrackedItems(query: WatchlistQuery = {}, options: RequestOptions = {}): Promise<dto.TrackedItems> {
    return this.read(`/tracked-items${queryString(query)}`, dto.trackedItems, options);
  }
  getTrackedItem(id: string, options: RequestOptions = {}): Promise<dto.TrackedItem> {
    return this.read(`/tracked-items/${idPath(id)}`, ownedTracker(id), options);
  }
  createTrackedItem(values: dto.CreateTracker, idempotencyKey: string, options: RequestOptions = {}): Promise<dto.TrackedItem> {
    const body = input(() => {
      const data = dto.object(values, ['previewId', 'targetPrice', 'enabled', 'alerts']);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new Error('Expected UUID.');
      return { previewId: dto.id(data.previewId), targetPrice: dto.money(data.targetPrice), enabled: dto.oneOf(data.enabled, [true, false]), alerts: dto.alerts(data.alerts) };
    });
    return this.mutate('POST', '/tracked-items', 201, body, dto.trackedItem, options, { 'Idempotency-Key': idempotencyKey });
  }
  updateTrackedItem(id: string, changes: Partial<dto.EditableTracker>, options: RequestOptions = {}): Promise<dto.TrackedItem> {
    const body = input(() => {
      const data = dto.object(changes, ['targetPrice', 'enabled', 'alerts']);
      const result = {
        ...('targetPrice' in data ? { targetPrice: dto.money(data.targetPrice) } : {}),
        ...('enabled' in data ? { enabled: dto.oneOf(data.enabled, [true, false]) } : {}),
        ...('alerts' in data ? { alerts: dto.alerts(data.alerts) } : {}),
      };
      if (!Object.keys(result).length) throw new Error('No changes.');
      return result;
    });
    return this.mutate('PATCH', `/tracked-items/${idPath(id)}`, 200, body, ownedTracker(id), options);
  }
  deleteTrackedItem(id: string, options: RequestOptions = {}): Promise<void> {
    return this.mutate('DELETE', `/tracked-items/${idPath(id)}`, 204, undefined, () => undefined, options);
  }
  getHistory(id: string, query: HistoryQuery = {}, options: RequestOptions = {}): Promise<dto.History> {
    return this.read(`/tracked-items/${idPath(id)}/history${queryString(query, true)}`, (value) => {
      const history = dto.history(value);
      if (history.trackedItemId !== id) throw new Error('Mismatched tracker.');
      return history;
    }, options);
  }
}
