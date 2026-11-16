export const MAX_PPM = 1_000_000

export function isValidPpm(x: unknown): x is number {
  return Number.isInteger(x) && (x as number) >= 0 && (x as number) <= MAX_PPM
}

export const MAX_CUT_LOSS_PPM = 500_000
// the web UI shows cut-loss as a percent with one decimal (35_000 ppm = 3.5 %)
export const CUT_LOSS_PPM_STEP = 1_000

export function isValidCutLossPpm(x: unknown): x is number {
  return Number.isInteger(x) && (x as number) >= 0 && (x as number) <= MAX_CUT_LOSS_PPM && (x as number) % CUT_LOSS_PPM_STEP === 0
}
