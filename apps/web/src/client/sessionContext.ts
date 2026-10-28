import { createContext, useContext } from 'react';
import type { WebClient, Session } from './webClient';
import { ClientError } from './http';
export const SessionContext = createContext<{
  client: WebClient;
  session: Session;
  busy: boolean;
  error?: unknown;
  retry(): void;
} | null>(null);
export const useApiSession = () => useContext(SessionContext);
export function isAborted(error: unknown): boolean {
  return error instanceof ClientError && error.kind === 'aborted';
}
