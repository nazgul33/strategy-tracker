import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see PendingTable.test.tsx.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { DefaultFeePrompt } = await import('./DefaultFeePrompt');
const { lookup } = await import('../../i18n/catalog');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('DefaultFeePrompt', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let used: number;
  let backs: number;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    used = 0;
    backs = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  async function show() {
    await act(async () => {
      root.render(
        d(DefaultFeePrompt, {
          rate: '0.004%',
          price: '12,345.00',
          shares: '10',
          fee: '4.94',
          onUse: () => {
            used += 1;
          },
          onBack: () => {
            backs += 1;
          },
        }),
      );
    });
  }

  const click = async (text: string) => {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button ${text} not found`);
    await act(async () => (btn as HTMLButtonElement).click());
  };

  it('shows the formula with the rate, price, quantity and fee', async () => {
    await show();
    expect(container.querySelector('[role=dialog]')).toBeTruthy();
    expect(container.textContent).toContain('Use the default fee?');
    expect(container.textContent).toContain(
      'The fee is empty, so the default fee will be booked: 0.004% × $12,345.00 × 10 sh = $4.94.',
    );
  });

  it('opens with focus on Go back, so a second Enter cannot book', async () => {
    await show();
    const back = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Go back');
    expect(back).toBeTruthy();
    expect(document.activeElement).toBe(back!);
  });

  it('Use default fee calls onUse once and nothing else', async () => {
    await show();
    await click('Use default fee');
    expect(used).toBe(1);
    expect(backs).toBe(0);
  });

  it('Go back calls onBack', async () => {
    await show();
    await click('Go back');
    expect(backs).toBe(1);
    expect(used).toBe(0);
  });

  it('closing the dialog goes back', async () => {
    await show();
    await click('✕');
    expect(backs).toBe(1);
    expect(used).toBe(0);
  });

  it('ko copy', () => {
    const params = { rate: '0.004%', price: '12,345.00', shares: '10', fee: '4.94' };
    expect(lookup('ko', 'pendingDefaultFeeBody', params)).toBe(
      '수수료가 비어 있어 기본 수수료가 적용됩니다: 0.004% × $12,345.00 × 10주 = $4.94.',
    );
  });
});
