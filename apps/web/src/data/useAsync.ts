import { useEffect, useState } from 'react';
export function useAsync<T>(load: () => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    data?: T;
    error?: unknown;
    loading: boolean;
  }>({ loading: true });
  useEffect(() => {
    let active = true;
    load().then(
      (data) => {
        if (active) setState({ data, loading: false });
      },
      (error: unknown) => {
        if (active) setState({ error, loading: false });
      },
    );
    return () => {
      active = false;
    };
  }, [load, attempt]);
  return {
    ...state,
    retry: () => {
      setState({ loading: true });
      setAttempt((value) => value + 1);
    },
  };
}
