import { ApiError } from './api';
import { errorText } from './errortext';

type T = (key: string, params?: Record<string, string | number>) => string;

/** Words for a failed review-tab request: the code stays visible, the advice does not depend on it. */
export function visionReviewErrorText(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    const server = /^http-5\d\d$/.test(err.code) || err.status >= 500;
    return t(server ? 'visionReviewErr.server' : 'visionReviewErr.other', { code: err.code });
  }
  return errorText(err, t);
}
