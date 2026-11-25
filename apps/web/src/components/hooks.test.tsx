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

  it('reads the notifications tab and the notice id from a run link', () => {
    expect(parseHash('#/runs/3?tab=notifications&notice=12')).toStrictEqual({ page: 'run', id: 3, tab: 'notifications', notice: 12 });
    expect(parseHash('#/runs/3?tab=notifications')).toStrictEqual({ page: 'run', id: 3, tab: 'notifications' });
  });

  it('ignores an unknown tab, a malformed notice, and a notice without the tab', () => {
    for (const q of ['tab=bogus&notice=12', 'notice=12', 'tab=', '']) {
      expect(parseHash(`#/runs/3?${q}`)).toStrictEqual({ page: 'run', id: 3 });
    }
    for (const n of ['abc', '0', '-1', '1e3', '1.5', '']) {
      expect(parseHash(`#/runs/3?tab=notifications&notice=${n}`)).toStrictEqual({ page: 'run', id: 3, tab: 'notifications' });
    }
  });

  it('other pages ignore the query', () => {
    expect(parseHash('#/pending?tab=notifications&notice=1')).toStrictEqual({ page: 'pending' });
    expect(parseHash('#/runs?tab=notifications')).toStrictEqual({ page: 'runs' });
  });

  it('parses the VR routes', () => {
    expect(parseHash('#/vr')).toStrictEqual({ page: 'vrRuns' });
    expect(parseHash('#/vr/3')).toStrictEqual({ page: 'vrRun', id: 3 });
  });

  it('rejects malformed VR routes', () => {
    for (const hash of ['#/vr/abc', '#/vr/0', '#/vr/1/x']) {
      expect(parseHash(hash)).toStrictEqual({ page: 'notFound', hash });
    }
  });
});
