import { createSampleRepository } from '../data/sampleRepository';
import { WebClient } from './webClient';
import type { TrackerRepository } from '../data/types';

export type Runtime =
  | {
      mode: 'sample';
      repository: TrackerRepository;
      onScenario?: ReturnType<typeof createSampleRepository>['setScenario'];
    }
  | { mode: 'api'; client: WebClient }
  | { mode: 'invalid'; message: string };
export function createRuntime(
  source = import.meta.env.VITE_DATA_SOURCE ?? 'sample',
): Runtime {
  if (source === 'sample') {
    const repository = createSampleRepository();
    return {
      mode: 'sample',
      repository,
      onScenario: (value) => repository.setScenario(value),
    };
  }
  if (source !== 'api')
    return {
      mode: 'invalid',
      message:
        'VITE_DATA_SOURCE must be sample or api. No data source was started.',
    };
  try {
    return { mode: 'api', client: new WebClient() };
  } catch {
    return {
      mode: 'invalid',
      message: 'Invalid API origin configuration. No session was started.',
    };
  }
}
export type EmailLink = { page: 'verify' | 'reset'; token: string | null };
// Call before React/router initialization, never persist the secret in history state.
export function captureEmailLink(): EmailLink | undefined {
  const page = ['/verify-email', '/verify'].includes(location.pathname)
    ? 'verify'
    : ['/reset-password', '/reset'].includes(location.pathname)
      ? 'reset'
      : undefined;
  if (!page) return undefined;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token =
    fragment.getAll('token').length === 1 ? fragment.get('token') : null;
  history.replaceState(null, '', location.pathname);
  return { page, token };
}
