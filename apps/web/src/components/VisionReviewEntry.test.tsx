import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { VisionReviewEntryDto, VisionReviewFillDto } from '../api.types';
import { EDITED, UNEDITED } from '../testing/visionReview';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — a hoisted
// import binds to the real DOM and events silently break.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { VisionReviewEntry } = await import('./VisionReviewEntry');
const { LangProvider } = await import('../i18n');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function entry(fills: VisionReviewFillDto[]): VisionReviewEntryDto {
  return { captureId: 3, runId: 7, ticker: 'AAPL', createdAt: '2026-11-10 14:30:00', mime: 'image/png', byteLen: 20480, fills };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem('st-lang');
});

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function render(fills: VisionReviewFillDto[]) {
  act(() => root.render(d(LangProvider, null, d(VisionReviewEntry, { entry: entry(fills), onDelete: () => {} }))));
}

describe('VisionReviewEntry accessibility', () => {
  it('names the row-label column for screen readers', () => {
    render([EDITED]);
    const th = container.querySelectorAll('thead th')[1]!;
    expect(th.querySelector('.sr-only')!.textContent).toBe('Source');
  });

  it('marks a changed field with a labelled glyph as well as the tint', () => {
    render([EDITED]);
    for (const kind of ['detected', 'final']) {
      const tr = container.querySelector(`[data-fill="11"][data-row="${kind}"]`)!;
      const marks = tr.querySelectorAll('[role="img"][aria-label="changed"]');
      expect(marks.length).toBe(1);
      expect(marks[0]!.closest('td')!.querySelector('[data-field]')!.getAttribute('data-field')).toBe('price');
      expect(marks[0]!.textContent).toBe('✎');
    }
  });

  it('keeps the marker out of a text selection, after the value it marks', () => {
    render([EDITED]);
    const mark = container.querySelector('[role="img"][aria-label="changed"]')!;
    expect(mark.className).toContain('select-none');
    expect(mark.previousElementSibling!.hasAttribute('data-field')).toBe(true);
  });

  it('an unchanged fill carries no marker', () => {
    render([UNEDITED]);
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it('names both in Korean', () => {
    localStorage.setItem('st-lang', 'ko');
    render([EDITED]);
    expect(container.querySelectorAll('thead th')[1]!.querySelector('.sr-only')!.textContent).toBe('출처');
    expect(container.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('변경됨');
  });
});
