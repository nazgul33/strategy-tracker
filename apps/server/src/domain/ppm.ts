export const MAX_PPM = 1_000_000

export function isValidPpm(x: unknown): x is number {
  return Number.isInteger(x) && (x as number) >= 0 && (x as number) <= MAX_PPM
}
