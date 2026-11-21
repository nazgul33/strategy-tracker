import { ApiError } from './api';

type T = (key: string, params?: Record<string, string | number>) => string;

// An explicit allow-list: a free-text server message can never match a catalog key by accident.
const KNOWN_CODES: ReadonlySet<string> = new Set([
  'sim-finalized',
  'not-found',
  'not-enough-bars',
  'market-data:http',
  'market-data:no-data',
]);

/** Words for a failed sim request; anything unmapped keeps its raw code. */
export function simErrorText(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    if (KNOWN_CODES.has(err.code)) return t(`simErr.${err.code}`);
    if (/^http-5\d\d$/.test(err.code)) return t('simErr.server', { code: err.code });
    return t('simActionFailed', { code: err.code });
  }
  return err instanceof Error ? err.message : String(err);
}
