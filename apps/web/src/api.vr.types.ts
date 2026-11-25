// Wire shapes of the VR routes (apps/server/src/domain/vr/view.ts). Cents are integers, prices are myriadth strings.
import type { RunStatus } from './api.types';

export type VrFormula = 'basic' | 'skill';
export type VrCashKind = 'open' | 'deposit' | 'withdraw' | 'adjust';
export type VrSide = 'buy' | 'sell';

export interface VrSettingsDto {
  g: number;
  formula: VrFormula;
  bandPpm: number;
  spendLimitPpm: number;
  cycleDepositCents: number;
}

export interface VrRunDto {
  id: number;
  name: string;
  ticker: string;
  status: RunStatus;
  costPpm: number;
  createdAt: string;
  initialVCents: number;
  settings: VrSettingsDto;
}

export type VrRunSummaryDto = VrRunDto & {
  shares: number;
  poolCents: number;
  vCents: number | null;
  valueCents: number | null;
};

export interface VrCycleDto {
  id: number;
  seq: number;
  scheduledStart: string;
  startDate: string;
  endDate: string;
  nextStart: string;
  vCents: number;
  bandMinCents: number;
  bandMaxCents: number;
  openShares: number;
  openPoolCents: number;
  buyBudgetCents: number;
  buyLot: number;
  sellLot: number;
  prevClose: string | null;
  evalCents: number | null;
  poolBeforeCents: number | null;
  g: number;
  formula: VrFormula;
  depositCents: number;
  vKept: boolean;
}

export interface VrRungDto {
  shares: number;
  price: string;
}

export interface VrBooksDto {
  shares: number;
  poolCents: number;
  netInvestedCents: number;
  avgCost: string | null;
  evalCents: number | null;
  valueCents: number | null;
  profitCents: number | null;
}

export interface VrLadderDto {
  buy: VrRungDto[];
  sell: VrRungDto[];
  buyTotal: number;
  sellTotal: number;
}

export interface VrRunDetailDto {
  run: VrRunDto;
  today: string;
  lastClose: { date: string; close: string } | null;
  books: VrBooksDto;
  cycle: VrCycleDto | null;
  budgetLeftCents: number | null;
  buyInstruction: { shares: number; targetCents: number } | null;
  ladder: VrLadderDto;
}

export interface VrFillDto {
  id: number;
  side: VrSide;
  shares: number;
  price: string;
  fee: number;
  filledOn: string;
  source: 'manual' | 'capture';
  createdAt: string;
  beforeCycle: boolean;
}

export interface VrCashDto {
  id: number;
  kind: VrCashKind;
  amountCents: number;
  movedOn: string;
  note: string | null;
  cycleId: number | null;
  createdAt: string;
  beforeCycle: boolean;
}

export interface VrCreateInput {
  name: string;
  ticker: string;
  cashCents: number;
  initialStockCents?: number;
  g?: number;
  formula?: VrFormula;
  bandPpm?: number;
  spendLimitPpm?: number;
  cycleDepositCents?: number;
  costPpm?: number;
}

/** Prices and fees are USD strings ("45.15"); a blank or missing fee is left to the server (cost percent). */
export interface VrFillInput {
  side: VrSide;
  shares: number;
  price: string;
  fee?: string;
  filledOn: string;
}

export interface VrCashInput {
  kind: 'deposit' | 'withdraw' | 'adjust';
  amountCents: number;
  movedOn: string;
  note?: string;
}

export interface VrCashEdit {
  amountCents: number;
  movedOn: string;
  note?: string;
}
