// Tiny data + routing hooks (no external router/data libraries).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, getToken, setToken } from '../api';
import { loadDefaultCostText, peekDefaultCostText } from '../defaultcost';

export interface AsyncData<T> {
  data: T | undefined;
  error: string | undefined;
  /** the caught value behind `error`; undefined after a success */
  failure: unknown;
  loading: boolean;
  /** re-fetch (silent: keeps previous data on screen) */
  reload: () => Promise<void>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncData<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const value = await fnRef.current();
        setData(value);
        setError(undefined);
        setFailure(undefined);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setToken(null);
          if (window.location.hash !== '#/login') window.location.hash = '#/login';
        }
        setError(e instanceof Error ? e.message : String(e));
        setFailure(e);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const key = JSON.stringify(deps);
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, key]);

  const reload = useCallback(() => load(true), [load]);
  return { data, error, failure, loading, reload };
}

/**
 * Cost percent text state, prefilled from the server default (fetched once per
 * page, see `defaultcost.ts`). A value the operator typed before the default
 * arrived is never overwritten. `loadFailed` is true when the default could not
 * be loaded, until the operator types a cost.
 */
export function useDefaultCostText(): [text: string, setText: (v: string) => void, loadFailed: boolean] {
  const [text, setText] = useState(() => peekDefaultCostText() ?? '');
  const [failed, setFailed] = useState(false);
  const touched = useRef(false);
  useEffect(() => {
    let live = true;
    loadDefaultCostText().then(
      (loaded) => {
        if (live && !touched.current) setText(loaded);
      },
      () => {
        if (live && !touched.current) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return [
    text,
    (v) => {
      touched.current = true;
      setFailed(false);
      setText(v);
    },
    failed,
  ];
}

export type Route =
  | { page: 'runs' }
  | { page: 'run'; id: number }
  | { page: 'pending' }
  | { page: 'visionReview' }
  | { page: 'sim' }
  | { page: 'simRun'; id: number }
  | { page: 'settings' }
  | { page: 'login' }
  | { page: 'notFound'; hash: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0] ?? '';
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return { page: 'runs' };
  switch (parts[0]) {
    case 'runs':
      if (parts.length === 1) return { page: 'runs' };
      if (parts.length === 2) {
        const id = Number(parts[1]);
        if (Number.isInteger(id) && id > 0) return { page: 'run', id };
      }
      return { page: 'notFound', hash };
    case 'pending':
      return parts.length === 1 ? { page: 'pending' } : { page: 'notFound', hash };
    case 'vision-review':
      return parts.length === 1 ? { page: 'visionReview' } : { page: 'notFound', hash };
    case 'sim':
      if (parts.length === 1) return { page: 'sim' };
      if (parts.length === 2) {
        const id = Number(parts[1]);
        if (Number.isInteger(id) && id > 0) return { page: 'simRun', id };
      }
      return { page: 'notFound', hash };
    case 'settings':
      return parts.length === 1 ? { page: 'settings' } : { page: 'notFound', hash };
    case 'login':
      return parts.length === 1 ? { page: 'login' } : { page: 'notFound', hash };
    default:
      return { page: 'notFound', hash };
  }
}

export function useHashRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return useMemo(() => parseHash(hash), [hash]);
}

/** hash of the page we should send the user to when their token dies */
export function requireAuth(route: Route): boolean {
  return route.page !== 'login' && getToken() === null;
}
