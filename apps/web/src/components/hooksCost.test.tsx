// react-dom/client must stay a dynamic import: it has to load *after*
// GlobalRegistrator.register(), otherwise onChange handlers silently never fire.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { loadDefaultCostText, resetDefaultCostMemo } from '../defaultcost';
import { installFetchStub, restoreFetch } from '../testing/fetchStub';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { useDefaultCostText } = await import('./hooks');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('useDefaultCostText', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    resetDefaultCostMemo();
    installFetchStub([
      {
        url: '/api/settings',
        json: { visionBaseUrl: '', visionModel: '', digestLang: 'en', hasVisionApiKey: false, defaultCostPpm: 700 },
      },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
    resetDefaultCostMemo();
  });

  it('a later mount seeds from the resolved default on its first render', async () => {
    await loadDefaultCostText();

    const renders: string[] = [];
    const Probe = () => {
      renders.push(useDefaultCostText()[0]);
      return null;
    };
    await act(async () => root.render(d(Probe)));

    expect(renders[0]).toBe('0.070');
  });
});
