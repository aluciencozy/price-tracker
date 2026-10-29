import { useEffect, useState } from 'react';
export function useAsync<T>(load: () => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    data?: T;
    error?: unknown;
    loading: boolean;
    load?: () => Promise<T>;
  }>({ loading: true });
  useEffect(() => {
    let active = true;
    load().then(
      (data) => {
        if (active) setState({ data, loading: false, load });
      },
      (error: unknown) => {
        if (active) setState({ error, loading: false, load });
      },
    );
    return () => {
      active = false;
    };
  }, [load, attempt]);
  return {
    ...(state.load === load ? state : { loading: true }),
    retry: () => {
      setState({ loading: true });
      setAttempt((value) => value + 1);
    },
  };
}
