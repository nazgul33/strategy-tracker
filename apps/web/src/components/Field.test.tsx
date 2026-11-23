// Field's contract: the label names the control, the hint describes it
// (aria-describedby), and a hint that comes and goes never remounts the control.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx: a hoisted import binds to the real DOM and onChange
// silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { Field, Input } = await import('./ui');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('Field', () => {
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
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  const render = (node: React.ReactNode) => act(async () => root.render(node));
  const input = (id = 'x') => container.querySelector(`#${id}`) as HTMLInputElement;
  const describedBy = (el: Element) =>
    (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent);

  it('keeps the hint out of the label and wires it as the description', async () => {
    await render(d(Field, { label: 'Price', hint: 'Commas group thousands', children: d(Input, { id: 'x' }) }));
    expect(input().closest('label')!.textContent).toBe('Price');
    expect(describedBy(input())).toEqual(['Commas group thousands']);
    expect(container.querySelector('[data-field-hint]')!.closest('label')).toBeNull();
  });

  it('adds nothing when there is no hint', async () => {
    await render(d(Field, { label: 'Qty', children: d(Input, { id: 'x' }) }));
    expect(input().hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelector('[data-field-hint]')).toBeNull();
    expect(input().closest('label')!.textContent).toBe('Qty');
  });

  it("keeps the control's own description and puts the hint after it", async () => {
    await render(
      d(
        'div',
        null,
        d('span', { id: 'own-note' }, 'Own note'),
        d(Field, { label: 'Fee', hint: 'Auto fee', children: d(Input, { id: 'x', 'aria-describedby': 'own-note' }) }),
      ),
    );
    expect(describedBy(input())).toEqual(['Own note', 'Auto fee']);
  });

  it('gives each field its own hint', async () => {
    await render(
      d(
        'div',
        null,
        d(Field, { label: 'A', hint: 'hint a', children: d(Input, { id: 'a' }) }),
        d(Field, { label: 'B', hint: 'hint b', children: d(Input, { id: 'b' }) }),
      ),
    );
    expect(describedBy(input('a'))).toEqual(['hint a']);
    expect(describedBy(input('b'))).toEqual(['hint b']);
  });

  it('a hint that comes and goes keeps the same control and its focus', async () => {
    const field = (hint?: string) => d(Field, { label: 'Qty', hint, children: d(Input, { id: 'x' }) });
    await render(field());
    const before = input();
    before.focus();
    await render(field('Changed from what vision read'));
    expect(input()).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(describedBy(input())).toEqual(['Changed from what vision read']);
    await render(field());
    expect(input()).toBe(before);
    expect(input().hasAttribute('aria-describedby')).toBe(false);
  });

  it('children that are not one element are rendered as they are, with the hint still shown', async () => {
    await render(d(Field, { label: 'Pair', hint: 'two controls', children: [d(Input, { key: 'a', id: 'a' }), d(Input, { key: 'b', id: 'b' })] }));
    expect(input('a').hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelector('[data-field-hint]')!.textContent).toBe('two controls');
  });
});
