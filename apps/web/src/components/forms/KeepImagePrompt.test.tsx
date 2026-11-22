import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

// react-dom/client must load AFTER GlobalRegistrator.register() — see
// PendingTable.test.tsx: a hoisted import binds to the real DOM and onChange
// silently breaks.
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { KeepImagePrompt } = await import('./KeepImagePrompt');

const d = React.createElement;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('KeepImagePrompt', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let decisions: boolean[];
  let dismissals: number;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    decisions = [];
    dismissals = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  async function show(action: 'confirm' | 'reject') {
    await act(async () => {
      root.render(
        d(KeepImagePrompt, {
          action,
          onDecide: (keep: boolean) => decisions.push(keep),
          onDismiss: () => {
            dismissals += 1;
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

  it('renders in the default narrow modal', async () => {
    await show('confirm');
    const panel = container.querySelector('[role=dialog] > div')!;
    expect(panel.className).toContain('max-w-md');
    expect(panel.className).not.toContain('max-w-4xl');
  });

  it('the confirm variant asks about the edited values', async () => {
    await show('confirm');
    expect(container.querySelector('[role=dialog]')).toBeTruthy();
    expect(container.textContent).toContain('Values were edited');
    expect(container.textContent).toContain(
      'You changed this fill before confirming, so vision may have misread the screenshot. Keep the screenshot for review?',
    );
  });

  it('the reject variant leads with the rejection instead', async () => {
    await show('reject');
    expect(container.textContent).toContain('Rejecting this fill');
    expect(container.textContent).toContain('Vision may have misread the screenshot. Keep the screenshot for review?');
    expect(container.textContent).not.toContain('Values were edited');
  });

  it('leads with Keep for review as the primary button, Discard second', async () => {
    await show('confirm');
    const buttons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent !== '✕');
    expect(buttons.map((b) => b.textContent)).toEqual(['Keep for review', 'Discard']);
    expect(buttons[0]!.className).toContain('bg-primary');
    expect(buttons[1]!.className).not.toContain('bg-primary');
  });

  it('Keep for review decides true, and nothing else', async () => {
    await show('confirm');
    await click('Keep for review');
    expect(decisions).toEqual([true]);
    expect(dismissals).toBe(0);
  });

  it('Discard decides false, and nothing else', async () => {
    await show('confirm');
    await click('Discard');
    expect(decisions).toEqual([false]);
    expect(dismissals).toBe(0);
  });

  it('closing the dialog dismisses without deciding', async () => {
    await show('reject');
    await click('✕');
    expect(dismissals).toBe(1);
    expect(decisions).toEqual([]);
  });

  it('returns focus to the button that opened the prompt', async () => {
    // The prompt as it sits in PendingTable: a row button opens it, and
    // closing it must put the caret back on that button.
    function Host() {
      const [open, setOpen] = React.useState(false);
      return d(
        'div',
        null,
        d('button', { id: 'hostBtn', onClick: () => setOpen(true) }, 'Review'),
        open &&
          d(KeepImagePrompt, {
            action: 'confirm',
            onDecide: (keep: boolean) => {
              decisions.push(keep);
              setOpen(false); // like PendingTable: a decision ends the prompt
            },
            onDismiss: () => {
              dismissals += 1;
              setOpen(false);
            },
          }),
      );
    }
    await act(async () => root.render(d(Host)));
    const opener = document.getElementById('hostBtn')!;
    await act(async () => opener.focus()); // a real activation focuses the button; happy-dom click() does not
    await act(async () => opener.click());
    expect(container.textContent).toContain('Keep for review');
    await click('Discard');
    expect(decisions).toEqual([false]);
    expect(document.activeElement).toBe(opener);
  });

  it('Escape closes the prompt', async () => {
    await show('reject');
    await act(async () => {
      document.body.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(dismissals).toBe(1);
    expect(decisions).toEqual([]);
  });
});
