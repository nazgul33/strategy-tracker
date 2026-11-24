import { extractFills } from '@st/ingest';

import { ingestCapture } from '../domain/booking';
import type { CaptureOutcome, RepoSurface } from '../domain/booking';

export interface CaptureRouteDeps {
  repos: RepoSurface;
  vision: { baseUrl: string; model: string };
  getVisionApiKey(): Promise<string>;
  today(): string;
  fetchImpl?: typeof fetch;
}

export type CaptureEvent =
  | { type: 'unknown-run'; id: number }
  | { type: 'bad-extract'; detail: string }
  | { type: 'pin-nomatch'; runId: number; ticker: string }
  | { type: 'pin-skipped'; runId: number; tickers: string[] }
  | { type: 'no-run'; ticker: string }
  | { type: 'ambiguous'; ticker: string }
  | { type: 'outcome'; runId: number; ticker: string; outcome: CaptureOutcome };

export type CaptureEventSink = (event: CaptureEvent) => Promise<void>;

export interface RouteCaptureRequest {
  image: { base64: string; mime: string };
  pinnedRunId: number | null;
}

export type RouteCapture = (req: RouteCaptureRequest, emit: CaptureEventSink) => Promise<void>;

// The pin and auto-route rules for one screenshot, reported as events in the order
// they happen. A throw (e.g. from a repo) propagates after the earlier events were emitted.
export function makeCaptureRouting(deps: CaptureRouteDeps): RouteCapture {
  return async function routeCapture({ image, pinnedRunId }, emit) {
    let pinned: { id: number; ticker: string } | null = null;
    if (pinnedRunId !== null) {
      const run = await deps.repos.runRepo.get(pinnedRunId);
      if (!run) {
        await emit({ type: 'unknown-run', id: pinnedRunId });
        return;
      }
      pinned = { id: run.id, ticker: run.ticker };
    }

    const cfg = {
      baseUrl: deps.vision.baseUrl,
      apiKey: await deps.getVisionApiKey(),
      model: deps.vision.model,
      maxTokens: 4096,
      today: deps.today(),
    };
    const extract = await extractFills([image], cfg, deps.fetchImpl);
    if (!extract.ok) {
      await emit({ type: 'bad-extract', detail: extract.detail });
      return;
    }

    if (pinned) {
      // pinned mode: book ONLY fills carrying the pinned run's own ticker — one run
      // has exactly one ticker — and tell the user what was ignored.
      const { id: pinId, ticker: pinTicker } = pinned;
      const own = extract.fills.filter((f: { ticker: string }) => f.ticker === pinTicker);
      const ignored = [...new Set(extract.fills.filter((f: { ticker: string }) => f.ticker !== pinTicker).map((f: { ticker: string }) => f.ticker))];
      if (own.length === 0) {
        await emit({ type: 'pin-nomatch', runId: pinId, ticker: pinTicker });
        return;
      }
      if (ignored.length > 0) {
        await emit({ type: 'pin-skipped', runId: pinId, tickers: ignored });
      }
      const outcome = await ingestCapture(pinId, image, { ...extract, fills: own }, {
        repos: deps.repos,
        today: deps.today(),
      });
      await emit({ type: 'outcome', runId: pinId, ticker: pinTicker, outcome });
      return;
    }

    // auto-route: each ticker group resolves to exactly one active run; groups
    // without a unique run are skipped with a one-line notice, never abort the rest.
    const groups = new Map<string, typeof extract.fills>();
    for (const fill of extract.fills) {
      const g = groups.get(fill.ticker);
      if (g) g.push(fill);
      else groups.set(fill.ticker, [fill]);
    }
    if (groups.size === 0) {
      await emit({ type: 'bad-extract', detail: 'no fills recognized' });
      return;
    }
    const active = (await deps.repos.runRepo.list()).filter((r) => r.status === 'active');
    for (const [ticker, fills] of groups) {
      const matches = active.filter((r) => r.ticker === ticker);
      if (matches.length === 0) {
        await emit({ type: 'no-run', ticker });
        continue;
      }
      if (matches.length > 1) {
        await emit({ type: 'ambiguous', ticker });
        continue;
      }
      const runId = matches[0]!.id;
      const outcome = await ingestCapture(runId, image, { ...extract, fills }, {
        repos: deps.repos,
        today: deps.today(),
      });
      await emit({ type: 'outcome', runId, ticker, outcome });
    }
  };
}
