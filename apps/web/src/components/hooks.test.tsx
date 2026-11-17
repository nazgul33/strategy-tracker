import { describe, expect, it } from 'bun:test';

import { parseHash } from './hooks';

describe('parseHash', () => {
  it('parses #/vision-review', () => {
    expect(parseHash('#/vision-review')).toEqual({ page: 'visionReview' });
  });

  it('rejects #/vision-review/extra', () => {
    expect(parseHash('#/vision-review/extra')).toEqual({ page: 'notFound', hash: '#/vision-review/extra' });
  });

  it('still parses the existing pages', () => {
    expect(parseHash('')).toEqual({ page: 'runs' });
    expect(parseHash('#/pending')).toEqual({ page: 'pending' });
    expect(parseHash('#/runs/4')).toEqual({ page: 'run', id: 4 });
  });
});
