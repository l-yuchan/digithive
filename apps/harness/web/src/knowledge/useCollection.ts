import { useEffect, useState } from "react";

export function useCollection<T>(load: () => Promise<T[]>) {
  const [snapshot, setSnapshot] = useState<{
    load: () => Promise<T[]>;
    version: number;
    rows: T[] | null;
    error: string | null;
  } | null>(null);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    load()
      .then((next) => {
        if (current) setSnapshot({ load, version, rows: next, error: null });
      })
      .catch((error: unknown) => {
        if (current) {
          setSnapshot((previous) => ({
            load,
            version,
            rows: previous?.rows ?? null,
            error: `목록을 불러오지 못했습니다: ${String(error)}`,
          }));
        }
      });
    return () => {
      current = false;
    };
  }, [load, version]);

  function refresh() {
    setVersion((previous) => previous + 1);
  }

  function mutate(label: string, request: () => Promise<void>) {
    setPending(label);
    setActionError(null);
    request()
      .then(refresh)
      .catch((error: unknown) => setActionError(`${label} 실패: ${String(error)}`))
      .finally(() => setPending(null));
  }

  const loading = snapshot?.load !== load || snapshot.version !== version;
  return {
    rows: snapshot?.rows ?? null,
    loading,
    loadError: loading ? null : snapshot.error,
    pending,
    actionError,
    mutate,
    refresh,
  };
}

export type Collection<T> = ReturnType<typeof useCollection<T>>;
