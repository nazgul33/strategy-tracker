import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() (see FillDialog.test.tsx).
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { BucketSelect } = await import('./BucketSelect');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('BucketSelect', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  async function render(value: string, held = [{ index: 0, shares: 10 }]) {
    await act(async () => {
      root.render(d(BucketSelect, { value, held, onChange: () => {}, 'aria-label': 'Bucket' }));
    });
    return container.querySelector('select')!;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('labels buckets 1-based, like the bucket board, and keeps a chosen bucket that is no longer held visible', async () => {
    const select = await render('3');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Automatic', 'Bucket 1 · 10 sh', 'Bucket 4']);
    expect(select.value).toBe('3');
  });

  it('keeps the option values on the stored 0-based index', async () => {
    const select = await render('3');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', '0', '3']);
  });

  it('adds no extra option for a held choice or for Automatic', async () => {
    expect((await render('0')).options.length).toBe(2);
    expect((await render('')).options.length).toBe(2);
  });
});
