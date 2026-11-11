import { useCallback, useEffect, useState, type DependencyList } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

const remembered = new Map<string, unknown>();
const rememberedLimit = 60;

function remember(key: string, value: unknown): void {
  remembered.delete(key);
  remembered.set(key, value);
  if (remembered.size > rememberedLimit) remembered.delete(remembered.keys().next().value as string);
}

export function useAsync<T>(loader: () => Promise<T>, dependencies: DependencyList, cacheKey?: string): AsyncState<T> {
  const [data, setData] = useState<T | null>(() => (cacheKey !== undefined ? ((remembered.get(cacheKey) as T | undefined) ?? null) : null));
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(() => cacheKey === undefined || !remembered.has(cacheKey));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (cacheKey !== undefined && remembered.has(cacheKey) && attempt === 0) {
      setData(remembered.get(cacheKey) as T);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    loader()
      .then((result) => {
        if (cancelled) return;
        if (cacheKey !== undefined) remember(cacheKey, result);
        setData(result);
      })
      .catch((failure) => {
        if (!cancelled) setError(failure);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { data, error, loading, reload };
}
