import { errorDetail, type ErrorDetail } from './dto';

export type ErrorKind = 'http' | 'network' | 'timeout' | 'aborted' | 'invalid-response' | 'invalid-input';
export class ClientError extends Error {
  readonly name = 'ClientError';
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly details: Partial<ErrorDetail> & { status?: number } = {},
  ) { super(message); }
}
export type RequestOptions = { signal?: AbortSignal };
type HttpRequestOptions = RequestOptions & {
  body?: unknown; headers?: Record<string, string>; onUnauthorized?: () => void;
};
export type HttpOptions = {
  baseUrl?: string; development?: boolean; timeoutMs?: number; fetch?: typeof fetch;
};

export function apiOrigin(base: string, development: boolean): string {
  if (base === '') return '';
  try {
    const url = new URL(base);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:'))) throw new Error();
    return url.origin;
  } catch {
    throw new ClientError('invalid-input', 'API base URL must be an HTTPS origin (localhost/127.0.0.1 HTTP is debug-only).');
  }
}
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date) || new Date(date).toUTCString() !== trimmed) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}
function cancelled(): ClientError { return new ClientError('aborted', 'Request cancelled.'); }
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    void response.body?.cancel().catch(() => {});
    throw new Error('Not JSON.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing body.');
  const decoder = new TextDecoder();
  let bytes = 0, json = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw cancelled();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_048_576) {
        void reader.cancel().catch(() => {});
        throw new Error('Response too large.');
      }
      json += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export function createHttp(options: HttpOptions) {
  const base = apiOrigin(options.baseUrl ?? import.meta.env.VITE_API_BASE_URL ?? '', options.development ?? import.meta.env.DEV);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new ClientError('invalid-input', 'Request timeout must be between 1 and 30000 ms.');
  }
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function attempt<T>(method: string, path: string, expectedStatus: number, parse: (value: unknown) => T, options: HttpRequestOptions): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (controller.signal.aborted) throw cancelled();
      const response = await fetcher(`${base}/api${path}`, {
        method, credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (controller.signal.aborted) throw cancelled();
      if (response.status === 401) options.onUnauthorized?.();
      if (response.status === 204 && expectedStatus === 204) return parse(undefined);
      try {
        const value = await readJson(response, controller.signal);
        if (controller.signal.aborted) throw cancelled();
        if (!response.ok) {
          const detail = errorDetail(value);
          const header = retryAfter(response.headers.get('Retry-After'));
          const retryAfterSeconds = header === undefined ? detail.retryAfterSeconds : Math.max(header, detail.retryAfterSeconds ?? 0);
          throw new ClientError('http', detail.message, { ...detail, retryAfterSeconds, status: response.status });
        }
        if (response.status !== expectedStatus) throw new Error('Unexpected status.');
        return parse(value);
      } catch (error) {
        if (error instanceof ClientError) throw error;
        throw new ClientError('invalid-response', 'Unexpected API response.', { status: response.status });
      }
    } catch (error) {
      if (timedOut) throw new ClientError('timeout', 'The API request timed out.');
      if (controller.signal.aborted) throw cancelled();
      if (error instanceof ClientError) throw error;
      throw new ClientError('network', 'Could not reach the API. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  return async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, expectedStatus: number,
    parse: (value: unknown) => T, options: HttpRequestOptions = {},
  ): Promise<T> {
    for (let retry = 0; ; retry++) {
      try { return await attempt(method, path, expectedStatus, parse, options); }
      catch (error) {
        if (!(error instanceof ClientError)) throw error;
        const transient = error.kind === 'network' || error.kind === 'timeout' ||
          (error.kind === 'http' && [429, 503].includes(error.details.status ?? 0));
        const minimumWait = error.details.retryAfterSeconds ?? 0;
        // Long server waits go back to the UI; never clamp and retry too early.
        if (method !== 'GET' || retry >= 2 || !transient || minimumWait >= 30) throw error;
        await wait(Math.max(250 * 2 ** retry, minimumWait * 1000) + Math.floor(Math.random() * 250), options.signal);
      }
    }
  };
}
