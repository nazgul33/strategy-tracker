import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — a hoisted
// import binds to the real DOM and events silently break.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RunHistory } = await import('./RunHistory');
const { LangProvider } = await import('../i18n');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function closedDto(over: Partial<import('../api').ClosedBucketDto> = {}): import('../api').ClosedBucketDto {
  return {
    index: 0,
    shares: 60,
    buyPrice: '3402300',
    soldPrice: '3501000',
    buyFeeCents: 102,
    sellFeeCents: 105,
    openedOn: '2026-01-05',
    closedOn: '2026-01-09',
    ...over,
  };
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function render(node: React.ReactElement) {
  root = createRoot(container);
  return act(() => root.render(d(LangProvider, null, node)));
}

function texts(selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((el) => el.textContent ?? '');
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

describe('RunHistory', () => {
  it('renders repeated same-date rows', async () => {
    // Partial sells close the same bucket index twice on one date: the row key
    // must stay unique so React does not warn about duplicate keys.
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      await render(d(RunHistory, { closed: [closedDto({ shares: 60 }), closedDto({ shares: 40 })] }));
    } finally {
      console.error = originalError;
    }
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(texts('tbody tr td:nth-child(4)')).toEqual(['60', '40']);
    const keyWarnings = logged.filter((args) => args.some((a) => String(a).includes('same key')));
    expect(keyWarnings).toEqual([]);
  });

  it('Update calls onRecalc and disables while pending', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    let calls = 0;
    const onRecalc = () => {
      calls += 1;
      return pending;
    };
    await render(d(RunHistory, { closed: [closedDto(), closedDto({ shares: 40 })], onRecalc }));
    expect(texts('thead th').at(-1)).toBe('Actions');
    const buttons = [...container.querySelectorAll('tbody button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Update', 'Update']);

    await click(buttons[0]!);
    expect(calls).toBe(1);
    // every line is disabled while one recalc is in flight
    expect(buttons.map((b) => b.hasAttribute('disabled'))).toEqual([true, true]);

    await act(async () => {
      resolve();
      await pending;
    });
    expect(buttons.map((b) => b.hasAttribute('disabled'))).toEqual([false, false]);
    expect(calls).toBe(1);
  });

  it('no actions column without onRecalc', async () => {
    await render(d(RunHistory, { closed: [closedDto()] }));
    expect(texts('thead th')).not.toContain('Actions');
    expect(texts('thead th')).not.toContain('관리');
    expect(container.querySelectorAll('tbody button')).toHaveLength(0);
  });
});
