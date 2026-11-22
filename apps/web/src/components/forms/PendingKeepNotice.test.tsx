import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import type { PendingFillDto } from '../../api.types';

if (!globalThis.IS_REACT_ACT_ENVIRONMENT) globalThis.IS_REACT_ACT_ENVIRONMENT = true;
GlobalRegistrator.register();

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { PendingTable } = await import('./PendingTable');
const { lookup } = await import('../../i18n/catalog');
const { useT } = await import('../../i18n');
const { installFetchStub, restoreFetch } = await import('../../testing/fetchStub');
const { PENDING_ROW, setInputValue } = await import('../../testing/pendingRow');
type Route = Parameters<typeof installFetchStub>[0][number];

// A keep-requested confirm/reject whose review record could not be saved (`archived:
// false` even though the server keeps the screenshot before the row flips) must leave
// a LASTING, NAMED warning notice — not the old transient inline error, which vanished
// on the next action. Notices sit in ONE persistent `div[data-keep-notices][role=status]`
// live region (an element mounted together with its text is not reliably announced), each
// a `div[data-keep-notice]` naming the fill; the action error stays a `role=alert` with a
// stable testid (Review Round 2).
describe('pending keep record-failed notices', () => {
  afterEach(() => {
    roots.splice(0).forEach((root) => act(() => root.unmount()));
    restoreFetch();
    document.body.innerHTML = '';
  });
  afterAll(() => GlobalRegistrator.unregister());

  const roots: ReturnType<typeof createRoot>[] = [];

  // No provider wrapper (as in PendingTable.test.tsx): the catalog defaults to English.
  const host = React.createElement.bind(null) as unknown as (
    type: string | React.ComponentType<Record<string, unknown>>,
    props?: Record<string, unknown> | null,
    ...children: React.ReactNode[]
  ) => React.ReactElement;
  function t(key: string) {
    let out = '';
    function Probe() {
      const tt = useT();
      out = tt(key);
      return null;
    }
    const r = createRoot(document.createElement('div'));
    roots.push(r);
    act(() => r.render(host(Probe)));
    act(() => r.unmount());
    return out;
  }

  const flush = () =>
    act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

  function render() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push(root);
    act(() => root.render(host(PendingTable, { runId: 7 })));
    return el;
  }

  let container: HTMLElement = document.createElement('div');
  const btn = (text: string, root: ParentNode = container) =>
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)!;
  const noticeAt = (i: number) => container.querySelectorAll('[data-keep-notice]')[i] as HTMLElement;
  const dismissButtons = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[data-keep-notice] button')).filter(
      (b) => b.textContent?.trim() === t('dismiss'),
    );

  async function click(el: HTMLElement) {
    await act(async () => {
      el.click();
    });
    await flush();
  }
  // Happy-dom clicks do not move focus, so a keyboard-style press focuses first.
  async function pressByKeyboard(el: HTMLElement) {
    await act(async () => {
      el.focus();
    });
    await click(el);
  }
  const clickNamed = (label: string) => click(btn(label));
  async function typeField(label: string, value: string) {
    const el = container.querySelector(
      `tbody tr:nth-child(1) input[aria-label="${label}"]`,
    ) as HTMLInputElement;
    await act(async () => setInputValue(el, value));
  }
  const editQty = (value: string) => typeField(t('pendingColQty'), value);
  async function confirmKeeping(label: string) {
    await clickNamed(t('pendingConfirm'));
    await clickNamed(label);
  }

  // A keep-requested POST that answers `archived: false` — the row flips, the review
  // record does not exist. Reading `json` drops the handled row, so the reload that
  // follows removes it, exactly as the real list route does after a booking.
  const keepFailed = (url: string, after: () => void): Route => ({
    url,
    method: 'POST',
    status: 200,
    get json() {
      after();
      return { ok: true, archived: false };
    },
  });
  function backend(state: { rows: PendingFillDto[] }, posts: Route[]) {
    const calls = installFetchStub([
      ...posts,
      {
        url: '/api/pending',
        method: 'GET',
        get json() {
          return state.rows;
        },
      },
    ]);
    return { posts: (url: string) => calls.filter((c) => c.url.includes(url)) };
  }

  it('names the fill, in warning style, as a status', async () => {
    const state = { rows: [PENDING_ROW] };
    backend(state, [keepFailed('/api/pending/9/confirm', () => (state.rows = []))]);
    container = render();
    await flush();

    await editQty('11');
    await confirmKeeping(t('keepImageKeep'));

    const notice = noticeAt(0);
    expect(notice.closest('[role=status]')).toBe(container.querySelector('[data-keep-notices]'));
    expect(notice.getAttribute('role')).toBeNull();
    expect(notice.className).toContain('text-warning');
    expect(notice.className).not.toContain('text-destructive');
    expect(notice.textContent).toContain(
      'Booked AAPL Buy 11 sh @ $12345.00 on 2026-11-10, but its review record could not be saved.',
    );
  });

  it('keeps one polite live region mounted, empty until a notice arrives', async () => {
    const state = { rows: [PENDING_ROW] };
    backend(state, [keepFailed('/api/pending/9/confirm', () => (state.rows = []))]);
    container = render();
    await flush();

    const region = container.querySelector('[data-keep-notices]') as HTMLElement;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.childElementCount).toBe(0);
    expect(region.textContent).toBe('');

    await editQty('11');
    await confirmKeeping(t('keepImageKeep'));

    // The very same element, so a screen reader sees text added to a live region.
    expect(container.querySelector('[data-keep-notices]')).toBe(region);
    expect(region.childElementCount).toBe(1);
    expect(region.textContent).toContain('Booked AAPL Buy 11 sh');
  });

  it('a reject names it as rejected', async () => {
    const state = { rows: [PENDING_ROW] };
    backend(state, [keepFailed('/api/pending/9/reject', () => (state.rows = []))]);
    container = render();
    await flush();

    await clickNamed(t('pendingReject'));
    await clickNamed(t('keepImageKeep'));

    expect(noticeAt(0).textContent).toContain('Rejected AAPL Buy 10 sh @ $12345.00 on 2026-11-10');
  });

  it('the notice survives a failed list read after the booking', async () => {
    const list: Route = { url: '/api/pending', method: 'GET', status: 200, json: [PENDING_ROW] };
    installFetchStub([
      { url: '/api/pending/9/confirm', method: 'POST', status: 200, json: { ok: true, archived: false } },
      list,
    ]);
    container = render();
    await flush();

    await editQty('11');
    list.status = 500;
    list.json = { error: 'boom' };
    await confirmKeeping(t('keepImageKeep'));

    expect(noticeAt(0).textContent).toContain('Booked AAPL Buy 11 sh');
  });

  it('stays silent when the review record was saved (archived: true)', async () => {
    const state = { rows: [PENDING_ROW] };
    installFetchStub([
      { url: '/api/pending/9/confirm', method: 'POST', status: 200, json: { ok: true, archived: true } },
      { url: '/api/pending', method: 'GET', get json() { return state.rows; } },
    ]);
    container = render();
    await flush();

    await editQty('11');
    await confirmKeeping(t('keepImageKeep'));

    expect(container.querySelectorAll('[data-keep-notice]')).toHaveLength(0);
  });

  it('survives the next action and its error', async () => {
    const row2 = { ...PENDING_ROW, id: 10, ticker: 'MSFT' };
    const state = { rows: [PENDING_ROW, row2] };
    const b = backend(state, [
      { url: '/api/pending/10/confirm', method: 'POST', status: 422, json: { error: 'too-many-shares' } },
      keepFailed('/api/pending/9/confirm', () => (state.rows = [row2])),
    ]);
    container = render();
    await flush();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);

    await editQty('11'); // an edited row gets the keep prompt; an untouched one posts at once
    await confirmKeeping(t('keepImageKeep'));
    expect(noticeAt(0)).toBeTruthy();

    await clickNamed(t('pendingConfirm')); // the MSFT row, untouched: posts with no prompt
    expect(b.posts('/api/pending/10/confirm')).toHaveLength(1);
    expect(container.textContent).toContain(lookup('en', 'fillErr.too-many-shares'));
    expect(noticeAt(0)?.textContent).toContain('Booked AAPL Buy 11 sh');

    const alert = container.querySelector('[data-testid="pendingActionError"]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe(lookup('en', 'fillErr.too-many-shares'));
  });

  it('two notices stack and dismiss one at a time', async () => {
    const row2 = { ...PENDING_ROW, id: 10, ticker: 'MSFT' };
    const state = { rows: [PENDING_ROW, row2] };
    const b = backend(state, [
      keepFailed('/api/pending/9/confirm', () => (state.rows = [row2])),
      keepFailed('/api/pending/10/confirm', () => (state.rows = [])),
    ]);
    container = render();
    await flush();

    await editQty('11');
    await confirmKeeping(t('keepImageKeep'));
    await editQty('11'); // the MSFT row sits first now
    await confirmKeeping(t('keepImageKeep'));
    expect(b.posts('/api/pending/9/confirm')).toHaveLength(1);
    expect(b.posts('/api/pending/10/confirm')).toHaveLength(1);

    expect(container.querySelectorAll('[data-keep-notice]')).toHaveLength(2);
    expect(noticeAt(0).textContent).toContain('AAPL'); // oldest first
    expect(noticeAt(1).textContent).toContain('MSFT');

    await click(dismissButtons()[0]!);
    expect(container.querySelectorAll('[data-keep-notice]')).toHaveLength(1);
    expect(noticeAt(0).textContent).toContain('MSFT');

    await click(dismissButtons()[0]!);
    expect(container.querySelectorAll('[data-keep-notice]')).toHaveLength(0);
  });

  it('dismissing moves focus to the next notice, then to the region when none remain', async () => {
    const row2 = { ...PENDING_ROW, id: 10, ticker: 'MSFT' };
    const state = { rows: [PENDING_ROW, row2] };
    backend(state, [
      keepFailed('/api/pending/9/confirm', () => (state.rows = [row2])),
      keepFailed('/api/pending/10/confirm', () => (state.rows = [])),
    ]);
    container = render();
    await flush();
    await editQty('11');
    await confirmKeeping(t('keepImageKeep'));
    await editQty('11');
    await confirmKeeping(t('keepImageKeep'));
    expect(dismissButtons()).toHaveLength(2);

    await pressByKeyboard(dismissButtons()[0]!);
    expect(dismissButtons()).toHaveLength(1);
    expect(document.activeElement).toBe(dismissButtons()[0]!);

    await pressByKeyboard(dismissButtons()[0]!);
    expect(container.querySelectorAll('[data-keep-notice]')).toHaveLength(0);
    expect(document.activeElement).toBe(container.querySelector('[data-keep-notices]'));
  });

  it('the action error is an alert with a stable hook', async () => {
    const state = { rows: [PENDING_ROW] };
    backend(state, [{ url: '/api/pending/9/confirm', method: 'POST', status: 409, json: { error: 'ticker-mismatch' } }]);
    container = render();
    await flush();

    await clickNamed(t('pendingConfirm'));

    const alert = container.querySelector('[data-testid="pendingActionError"]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe(t('pendingTickerMismatch'));
    expect(container.querySelectorAll('[data-keep-notice]')).toHaveLength(0);
  });

  it("dismissing the keep prompt after the fee popup returns focus to that row's Confirm", async () => {
    // The fee popup hands the row off to the keep prompt: the prompt's opener is the
    // "Use auto fee" button, which its own click destroys. Focus must follow the
    // chain to the control that opened the pair (Review Focus 1; Modal's opener chain).
    const state = { rows: [PENDING_ROW] };
    backend(state, []);
    container = render();
    await flush();

    await editQty('11'); // dirty, so the keep prompt waits for the row after the fee popup
    await typeField(t('pendingColFee'), ''); // a blanked fee makes Confirm ask about the auto fee
    const confirmBtn = btn(t('pendingConfirm'));
    await pressByKeyboard(confirmBtn); // opens the auto-fee popup
    expect(container.querySelector('[role=dialog]')!.textContent).toContain(t('pendingDefaultFeeUse'));
    await pressByKeyboard(btn(t('pendingDefaultFeeUse'))); // and its button hands off to the keep prompt
    expect(container.querySelector('[role=dialog]')!.textContent).toContain(t('keepImageKeep'));

    await click(btn('✕', container.querySelector('[role=dialog]')!));

    expect(document.activeElement).toBe(confirmBtn);
  });

  it('ko copy', () => {
    expect(lookup('ko', 'keepRecordFailedBooked', { ticker: 'AAPL', side: '매수', shares: '10', price: '1.00', date: '2026-11-10' })).toBe(
      'AAPL 매수 10주 @ $1.00, 2026-11-10 체결을 기록했지만 검토 기록을 저장하지 못했습니다. 스크린샷은 보관되었으며 다음 서버 재시작 후 검토 탭에 표시됩니다.',
    );
    expect(
      lookup('ko', 'keepRecordFailedRejected', { ticker: 'AAPL', side: '매도', shares: '10', price: '1.00', date: '2026-11-10' }),
    ).toBe(
      'AAPL 매도 10주 @ $1.00, 2026-11-10 체결을 반려했지만 검토 기록을 저장하지 못했습니다. 스크린샷은 보관되었으며 다음 서버 재시작 후 검토 탭에 표시됩니다.',
    );
  });
});
