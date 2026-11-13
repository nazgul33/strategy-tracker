// Line chart of the run ticker's settled daily closes, drawn as a hand-built
// SVG polyline (no chart library). Hovering anywhere shows the close of the
// nearest bar; the latest close is repeated below as the "current (delayed)"
// price. The window starts one trading day before the first buy — see
// priceHistory.ts — and the server backfills (and caches) those bars.
import { useState } from 'react';

import { api } from '../api';
import { priceUsd, todayIso } from '../format';
import { useT } from '../i18n';
import { computeHistoryWindow } from '../priceHistory';
import { useAsync } from './hooks';
import { ErrorNote, Spinner } from './ui';

const W = 640;
const H = 180;
const PAD = 10;

/** Myriadths (API decimal string) → dollars as a float, for pixel math only. */
function closeDollars(close: string): number {
  return Number(BigInt(close)) / 10_000;
}

export function PriceChart({ runId }: { runId: number }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);

  const state = useAsync(async () => {
    const fills = await api.listFills(runId);
    const window = computeHistoryWindow(
      fills.filter((f) => f.side === 'buy').map((f) => f.filledOn),
      todayIso(),
    );
    return api.priceHistory(runId, window.start ?? undefined);
  }, [runId]);

  if (state.loading && !state.data) return <Spinner />;
  if (state.error !== undefined) return <ErrorNote message={state.error} />;

  const bars = state.data?.bars ?? [];
  if (bars.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="priceChartEmpty">
        {t('runDetail.priceHistoryEmpty')}
      </p>
    );
  }

  const closes = bars.map((b) => closeDollars(b.close));
  const min = Math.min(...closes);
  const span = Math.max(...closes) - min || 1;
  const x = (i: number) => (bars.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (bars.length - 1));
  const y = (i: number) => PAD + (1 - (closes[i] - min) / span) * (H - 2 * PAD);
  const points = bars.map((_, i) => `${x(i).toFixed(1)},${y(i).toFixed(1)}`).join(' ');
  const last = bars.length - 1;

  return (
    <div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-44 w-full text-primary"
          data-testid="priceChartSvg"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 1;
            const idx = Math.round(Math.min(1, Math.max(0, ratio)) * last);
            setHover(Number.isFinite(idx) ? idx : null);
          }}
          onMouseLeave={() => setHover(null)}
        >
          <polyline
            data-testid="priceChartLine"
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
          {hover !== null && <circle cx={x(hover)} cy={y(hover)} r={3} fill="currentColor" />}
        </svg>
        {hover !== null && (
          <div
            data-testid="priceChartTooltip"
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded border bg-card px-2 py-1 text-xs whitespace-nowrap"
            style={{ left: `${((x(hover) / W) * 100).toFixed(1)}%` }}
          >
            {bars[hover].tradeDate}: {priceUsd(bars[hover].close)}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{bars[0].tradeDate}</span>
        <span data-testid="priceChartCurrent">
          {t('runDetail.currentPrice', { price: priceUsd(bars[last].close), date: bars[last].tradeDate })}
        </span>
      </div>
    </div>
  );
}
