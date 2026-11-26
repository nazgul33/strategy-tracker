// Shared VR fixtures (wire-shaped: cents are numbers, prices are myriadth strings). Pure data, no runtime imports.
import type {
  VrCashDto,
  VrCycleDto,
  VrFillDto,
  VrPendingDto,
  VrRunDetailDto,
  VrRunDto,
  VrRunSummaryDto,
  VrSettingsDto,
} from '../api.vr.types';
import type { Route } from './fetchStub';

// The story: opening cash 1,000,000 on 2026-11-05; 176 shares at 51.13 (fee 112) on 2026-11-06 leave a Pool of 100,000;
// cycles start on Mondays 2026-11-09, 2026-11-23 and 2026-12-07; in cycle 3, 3 shares at 45.15 (fee 9) on 2026-12-08.
export const VR_SETTINGS = {
  g: 10,
  formula: 'skill',
  bandPpm: 150_000,
  spendLimitPpm: 500_000,
  cycleDepositCents: 0,
} satisfies VrSettingsDto;

export const VR_RUN: VrRunDto = {
  id: 5,
  name: 'TQQQ lump sum',
  ticker: 'TQQQ',
  status: 'active',
  costPpm: 700,
  createdAt: '2026-11-05 14:00:00',
  initialVCents: 900_000,
  settings: VR_SETTINGS,
};

export const VR_SUMMARY: VrRunSummaryDto = {
  ...VR_RUN,
  shares: 179,
  poolCents: 86_446,
  vCents: 935_000,
  valueCents: 909_846,
  pendingCount: 0,
};

export const VR_SUMMARY_FRESH: VrRunSummaryDto = {
  ...VR_RUN,
  id: 6,
  name: 'SOXL fresh',
  ticker: 'SOXL',
  status: 'paused',
  initialVCents: 250_000,
  shares: 0,
  poolCents: 500_000,
  vCents: null,
  valueCents: null,
  pendingCount: 0,
};

export const VR_CYCLE: VrCycleDto = {
  id: 3,
  seq: 3,
  scheduledStart: '2026-12-07',
  startDate: '2026-12-07',
  endDate: '2026-12-20',
  nextStart: '2026-12-21',
  vCents: 935_000,
  bandMinCents: 794_750,
  bandMaxCents: 1_075_250,
  openShares: 176,
  openPoolCents: 100_000,
  buyBudgetCents: 50_000,
  buyLot: 3,
  sellLot: 2,
  prevClose: '601200',
  evalCents: 1_058_112,
  poolBeforeCents: 100_000,
  g: 10,
  formula: 'skill',
  depositCents: 0,
  vKept: false,
};

const SELL_CENTS = [
  6110, 6180, 6252, 6325, 6401, 6478, 6557, 6638, 6721, 6806, 6893, 6983, 7075, 7169, 7266, 7365, 7468, 7573, 7681,
  7792, 7907, 8025,
];

export const VR_DETAIL: VrRunDetailDto = {
  run: VR_RUN,
  today: '2026-12-09',
  lastClose: { date: '2026-12-08', close: '460000' },
  books: {
    shares: 179,
    poolCents: 86_446,
    netInvestedCents: 1_000_000,
    avgCost: '510298',
    evalCents: 823_400,
    valueCents: 909_846,
    profitCents: -90_154,
  },
  cycle: VR_CYCLE,
  budgetLeftCents: 36_455,
  buyInstruction: null,
  ladder: {
    buy: [
      { shares: 3, price: '443900' },
      { shares: 3, price: '436600' },
    ],
    sell: SELL_CENTS.map((c) => ({ shares: 2, price: String(c * 100) })),
    buyTotal: 3,
    sellTotal: 22,
  },
  pendingCount: 0,
};

/** The run detail with another id and name (the same books and ladder). */
export function vrDetail(over: Partial<VrRunDetailDto> & { id?: number; name?: string } = {}): VrRunDetailDto {
  const { id = VR_RUN.id, name = VR_RUN.name, ...rest } = over;
  return { ...VR_DETAIL, ...rest, run: { ...VR_RUN, id, name } };
}

/** Newest first, as the server sends them. */
export const VR_FILLS: VrFillDto[] = [
  { id: 12, side: 'buy', shares: 3, price: '451500', fee: 9, filledOn: '2026-12-08', source: 'manual', createdAt: '2026-12-08 16:10:00', beforeCycle: false },
  { id: 11, side: 'buy', shares: 176, price: '511300', fee: 112, filledOn: '2026-11-06', source: 'manual', createdAt: '2026-11-06 16:10:00', beforeCycle: true },
];

/** Waiting rows, ascending date as the server sends them. 33 had no date in the screenshot; 34 is dated after today. */
export const VR_PENDING: VrPendingDto[] = [
  { id: 31, captureId: 9, side: 'buy', shares: 3, price: '443900', fee: null, filledOn: '2026-12-08', dateRead: true, dateAfterToday: false, dupPrice: null, hasImage: true, createdAt: '2026-12-09 08:00:00' },
  { id: 32, captureId: 9, side: 'buy', shares: 3, price: '444000', fee: 9, filledOn: '2026-12-08', dateRead: true, dateAfterToday: false, dupPrice: '443900', hasImage: true, createdAt: '2026-12-09 08:00:00' },
  { id: 33, captureId: 9, side: 'sell', shares: 2, price: '611000', fee: null, filledOn: '2026-12-09', dateRead: false, dateAfterToday: false, dupPrice: null, hasImage: false, createdAt: '2026-12-09 08:00:00' },
  { id: 34, captureId: 10, side: 'buy', shares: 3, price: '436600', fee: null, filledOn: '2026-12-10', dateRead: true, dateAfterToday: true, dupPrice: null, hasImage: true, createdAt: '2026-12-09 08:05:00' },
];

export const VR_CASH: VrCashDto[] = [
  { id: 21, kind: 'open', amountCents: 1_000_000, movedOn: '2026-11-05', note: null, cycleId: null, createdAt: '2026-11-05 14:00:00', beforeCycle: true },
];

export const SETTINGS_ROUTE: Route = {
  url: '/api/settings',
  json: { visionBaseUrl: '', visionModel: '', digestLang: 'en', hasVisionApiKey: false, defaultCostPpm: 700 },
};

// Sub-resources first, run details next, the bare list last: the stub matches by substring.
export const VR_APP_ROUTES: Route[] = [
  { url: '/pending', json: [] },
  { url: '/cycles', json: [] },
  { url: '/fills', json: [] },
  { url: '/cash', json: [] },
  { url: '/notifications', json: [] },
  { url: '/api/vr/runs/1', json: vrDetail({ id: 1, name: 'First VR run' }) },
  { url: '/api/vr/runs/2', json: vrDetail({ id: 2, name: 'Second VR run' }) },
  { url: '/api/vr/runs', json: [VR_SUMMARY] },
];
