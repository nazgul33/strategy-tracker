import { ApiError, NetworkError } from './api';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Words a caught request failure. `keyPrefix` names the screen's own codes, e.g. 'fillErr' for `fillErr.not-last`. */
export function errorText(err: unknown, t: Translate, keyPrefix?: string): string {
  if (err instanceof NetworkError) return t('errNetwork');
  if (err instanceof ApiError) {
    if (keyPrefix) {
      const key = `${keyPrefix}.${err.code}`;
      const own = t(key);
      if (own !== key) return own;
    }
    const server = err.status >= 500 || /^http-5\d\d$/.test(err.code);
    return t(server ? 'errServer' : 'errRequest', { code: err.code });
  }
  return err instanceof Error ? err.message : String(err);
}
