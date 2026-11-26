import { extractFills } from '@st/ingest';
import type { RawFill } from '@st/ingest';

import { ingestCapture } from '../domain/booking';
import type { CaptureOutcome, RepoSurface } from '../domain/booking';
import { ingestVrCapture } from '../domain/vr/capture';
import type { VrCaptureOutcome, VrCaptureRepos } from '../domain/vr/capture';
import type { VrRepos, VrRunRow } from '../domain/vr/repo-types';

export type VisionSource = 'settings' | 'env';

export interface VisionInUse {
  model: string;
  modelSource: VisionSource;
  baseUrl: string;
  baseUrlSource: VisionSource;
  keySource: VisionSource | 'none';
}

export type BadExtractEvent =
  | { type: 'bad-extract'; reason: 'http' | 'unparseable' | 'incompatible'; detail: string; vision: VisionInUse }
  | { type: 'bad-extract'; reason: 'empty'; detail: string };

export interface VisionApiKey {
  key: string;
  source: VisionSource | 'none';
}

export type CaptureRouteRepos = RepoSurface & VrCaptureRepos & Pick<VrRepos, 'vrRunRepo'>;

export interface CaptureRouteDeps {
  repos: CaptureRouteRepos;
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
  | { type: 'choose'; ticker: string; mrRunId: number; vrRunId: number; fills: RawFill[] }
  | { type: 'outcome'; runId: number; ticker: string; outcome: CaptureOutcome }
  | { type: 'vr-outcome'; runId: number; ticker: string; outcome: VrCaptureOutcome };

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
function badExtract(reason: 'http' | 'unparseable' | 'incompatible' | 'empty', detail: string, vision: VisionInUse): BadExtractEvent {
  if (reason === 'empty') return { type: 'bad-extract', reason, detail };
  return { type: 'bad-extract', reason, detail, vision };
}

// The pin and auto-route rules for one screenshot, reported as events in the order
// they happen. A throw (e.g. from a repo) propagates after the earlier events were emitted.
export function makeCaptureRouting(deps: CaptureRouteDeps): RouteCapture {
  return async function routeCapture({ image, pinnedRunId, visionTimeoutMs }, emit) {
    let pinned: { kind: 'mr'; id: number; ticker: string } | { kind: 'vr'; run: VrRunRow } | null = null;
    if (pinnedRunId !== null) {
      const mr = await deps.repos.runRepo.get(pinnedRunId);
      const vr = mr ? null : await deps.repos.vrRunRepo.get(pinnedRunId);
      if (mr) pinned = { kind: 'mr', id: mr.id, ticker: mr.ticker };
      else if (vr) pinned = { kind: 'vr', run: vr };
      else {
        await emit({ type: 'unknown-run', id: pinnedRunId });
        return;
      }
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
      const pinId = pinned.kind === 'mr' ? pinned.id : pinned.run.id;
      const pinTicker = pinned.kind === 'mr' ? pinned.ticker : pinned.run.ticker;
      const own = extract.fills.filter((f: { ticker: string }) => f.ticker === pinTicker);
      const ignored = [...new Set(extract.fills.filter((f: { ticker: string }) => f.ticker !== pinTicker).map((f: { ticker: string }) => f.ticker))];
      if (own.length === 0) {
        await emit({ type: 'pin-nomatch', runId: pinId, ticker: pinTicker });
        return;
      }
      if (ignored.length > 0) {
        await emit({ type: 'pin-skipped', runId: pinId, tickers: ignored });
      }
      if (pinned.kind === 'vr') {
        const outcome = await ingestVrCapture(pinned.run, image, own, { repos: deps.repos, today: deps.today() });
        await emit({ type: 'vr-outcome', runId: pinId, ticker: pinTicker, outcome });
        return;
      }
      const outcome = await ingestCapture(pinId, image, { ...extract, fills: own }, {
        repos: deps.repos,
        today: deps.today(),
      });
      await emit({ type: 'outcome', runId: pinId, ticker: pinTicker, outcome });
      return;
    }

    // auto-route: each ticker group resolves to exactly one active run of either
    // strategy; a shared MR/VR pair asks (a choose event, nothing taken in). Other
    // groups without a unique run are skipped with a one-line notice, never abort the rest.
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
    const activeVr = (await deps.repos.vrRunRepo.list()).filter((r) => r.status === 'active');
    for (const [ticker, fills] of groups) {
      const matches = active.filter((r) => r.ticker === ticker);
      const vrMatches = activeVr.filter((r) => r.ticker === ticker);
      if (matches.length + vrMatches.length === 0) {
        await emit({ type: 'no-run', ticker });
        continue;
      }
      if (matches.length === 1 && vrMatches.length === 1) {
        await emit({ type: 'choose', ticker, mrRunId: matches[0]!.id, vrRunId: vrMatches[0]!.id, fills });
        continue;
      }
      if (matches.length + vrMatches.length > 1) {
        await emit({ type: 'ambiguous', ticker });
        continue;
      }
      if (vrMatches.length === 1) {
        const vrRun = vrMatches[0]!;
        const outcome = await ingestVrCapture(vrRun, image, fills, { repos: deps.repos, today: deps.today() });
        await emit({ type: 'vr-outcome', runId: vrRun.id, ticker, outcome });
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
