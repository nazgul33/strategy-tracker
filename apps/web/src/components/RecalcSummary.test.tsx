// Same harness as the other component tests: happy-dom first, then react-dom/client
// dynamically so it binds to the registered DOM.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { RecalcResultModal, RecalcSummary } = await import('./RecalcSummary');

const d = React.createElement;

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

afterAll(() => GlobalRegistrator.unregister());

const click = (el: Element) => {
  act(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
};

describe('RecalcSummary', () => {
  it('nonzero delta books the adjustment line with the signed amount', () => {
    act(() => root.render(d(RecalcSummary, { result: { deltaCents: 250, fillCount: 4 } })));
    expect(container.textContent).toContain('Rebuilt run state from 4 fills.');
    expect(container.textContent).toContain('+$2.50');
    expect(container.textContent).toContain('adjustment was booked');
  });

  it('zero delta shows the no-adjustment line and no amount', () => {
    act(() => root.render(d(RecalcSummary, { result: { deltaCents: 0, fillCount: 4 } })));
    expect(container.textContent).toContain('No cash adjustment was needed.');
    expect(container.textContent).not.toContain('$');
  });
});

describe('RecalcResultModal', () => {
  it('wraps the summary behind the title with a single OK button', () => {
    let closed = 0;
    act(() =>
      root.render(
        d(RecalcResultModal, { result: { deltaCents: -120, fillCount: 2 }, onClose: () => (closed += 1) }),
      ),
    );
    expect(container.textContent).toContain('Recalculation complete');
    expect(container.textContent).toContain('Rebuilt run state from 2 fills.');
    const okButtons = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'OK');
    expect(okButtons).toHaveLength(1);
    click(okButtons[0]!);
    expect(closed).toBe(1);
  });
});
