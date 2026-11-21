import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadDefaultCostText, peekDefaultCostText, resetDefaultCostMemo } from './defaultcost';
import { installFetchStub, restoreFetch } from './testing/fetchStub';

describe('default cost memo', () => {
  let settingsGets = 0;
  let settings: Record<string, unknown>;
  let route: { url: string; status: number; readonly json: unknown };

  beforeEach(() => {
    resetDefaultCostMemo();
    settingsGets = 0;
    settings = { visionBaseUrl: '', visionModel: '', digestLang: 'en', hasVisionApiKey: false, defaultCostPpm: 700 };
    route = {
      url: '/api/settings',
      status: 200,
      get json() {
        settingsGets += 1;
        return settings;
      },
    };
    installFetchStub([route]);
  });

  afterEach(() => {
    restoreFetch();
  });

  test('two loads share one /api/settings request', async () => {
    const [a, b] = await Promise.all([loadDefaultCostText(), loadDefaultCostText()]);
    expect([a, b]).toEqual(['0.070', '0.070']);
    expect(await loadDefaultCostText()).toBe('0.070');
    expect(settingsGets).toBe(1);
  });

  test('a failed load is not memoized: the next load asks again', async () => {
    route.status = 500;
    await expect(loadDefaultCostText()).rejects.toBeDefined();
    route.status = 200;
    expect(await loadDefaultCostText()).toBe('0.070');
    expect(settingsGets).toBe(2);
  });

  test('a non-finite defaultCostPpm counts as a failure', async () => {
    settings.defaultCostPpm = null;
    await expect(loadDefaultCostText()).rejects.toBeDefined();
  });

  test('peek is undefined until the load resolves, then the text', async () => {
    expect(peekDefaultCostText()).toBeUndefined();
    await loadDefaultCostText();
    expect(peekDefaultCostText()).toBe('0.070');
  });

  test('resetDefaultCostMemo forces a fresh request', async () => {
    await loadDefaultCostText();
    resetDefaultCostMemo();
    await loadDefaultCostText();
    expect(settingsGets).toBe(2);
  });
});
