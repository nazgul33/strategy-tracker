import { extractFills } from '@st/ingest';

import { ingestCapture } from '../domain/booking';
import type { CaptureOutcome, RepoSurface } from '../domain/booking';

export type VisionSource = 'settings' | 'env';

export interface VisionInUse {
  model: string;
  modelSource: VisionSource;
  baseUrl: string;
  baseUrlSource: VisionSource;
  keySource: VisionSource | 'none';
}

export type BadExtractEvent =
  | { type: 'bad-extract'; reason: 'http' | 'unparseable'; detail: string; vision: VisionInUse }
  | { type: 'bad-extract'; reason: 'empty'; detail: string };

export interface VisionApiKey {
  key: string;
  source: VisionSource | 'none';
}

export interface CaptureRouteDeps {
  repos: RepoSurface;
  vision: { baseUrl: string; baseUrlSource: VisionSource; model: string; modelSource: VisionSource };
  getVisionApiKey(): Promise<VisionApiKey>;
  today(): string;
  fetchImpl?: typeof fetch;
}

export type CaptureEvent =
  | { type: 'unknown-run'; id: number }
  | BadExtractEvent
  | { type: 'pin-nomatch'; runId: number; ticker: string }
  | { type: 'pin-skipped'; runId: number; tickers: string[] }
  | { type: 'no-run'; ticker: string }
  | { type: 'ambiguous'; ticker: string }
  | { type: 'outcome'; runId: number; ticker: string; outcome: CaptureOutcome };

export type CaptureEventSink = (event: CaptureEvent) => Promise<void>;

export const VISION_TIMEOUT_DETAIL = 'vision timed out';

export interface RouteCaptureRequest {
  image: { base64: string; mime: string };
  pinnedRunId: number | null;
  visionTimeoutMs?: number;
}

export type RouteCapture = (req: RouteCaptureRequest, emit: CaptureEventSink) => Promise<void>;

type ExtractArgs = Parameters<typeof extractFills>;

// Without a limit, extractFills runs exactly as before (no signal on the fetch).
// With one, the timer settles the race first and then aborts the in-flight request.
async function extractWithin(
  images: ExtractArgs[0],
  cfg: ExtractArgs[1],
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number | undefined,
): Promise<Awaited<ReturnType<typeof extractFills>>> {
  if (timeoutMs === undefined) return extractFills(images, cfg, fetchImpl);
  const controller = new AbortController();
  const inner = fetchImpl ?? globalThis.fetch;
  const signalled = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    inner(input, { ...init, signal: controller.signal })) as typeof fetch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; reason: 'http'; detail: string }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, reason: 'http', detail: VISION_TIMEOUT_DETAIL });
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([extractFills(images, cfg, signalled), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// An empty read is about the screenshot, not the setup, so it carries no vision config.
function badExtract(reason: 'http' | 'unparseable' | 'empty', detail: string, vision: VisionInUse): BadExtractEvent {
  if (reason === 'empty') return { type: 'bad-extract', reason, detail };
  return { type: 'bad-extract', reason, detail, vision };
}

// The pin and auto-route rules for one screenshot, reported as events in the order
// they happen. A throw (e.g. from a repo) propagates after the earlier events were emitted.
export function makeCaptureRouting(deps: CaptureRouteDeps): RouteCapture {
  return async function routeCapture({ image, pinnedRunId, visionTimeoutMs }, emit) {
    let pinned: { id: number; ticker: string } | null = null;
    if (pinnedRunId !== null) {
      const run = await deps.repos.runRepo.get(pinnedRunId);
      if (!run) {
        await emit({ type: 'unknown-run', id: pinnedRunId });
        return;
      }
      pinned = { id: run.id, ticker: run.ticker };
    }

    // The key value goes only into the request; events carry its source.
    const key = await deps.getVisionApiKey();
    const { baseUrl, baseUrlSource, model, modelSource } = deps.vision;
    const inUse: VisionInUse = { model, modelSource, baseUrl, baseUrlSource, keySource: key.source };
    const cfg = {
      baseUrl,
      apiKey: key.key,
      model,
      maxTokens: 4096,
      today: deps.today(),
    };
    const extract = await extractWithin([image], cfg, deps.fetchImpl, visionTimeoutMs);
    if (!extract.ok) {
      await emit(badExtract(extract.reason, extract.detail, inUse));
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
      await emit(badExtract('empty', 'no fills recognized', inUse));
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
