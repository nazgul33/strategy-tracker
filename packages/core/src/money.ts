export const TICK_USD = 100n

export function roundDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('d must be > 0')
  const q = n / d
  const r = n % d
  if (r !== 0n) {
    const absR = r < 0n ? -r : r
    if (absR * 2n >= d) {
      if (n >= 0n) return q + 1n
      return q - 1n
    }
  }
  return q
}

export function parseUsd(s: string): bigint {
  const t = s.trim()
  if (t === '') throw new Error('invalid usd')
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error('invalid usd')
  const neg = t.startsWith('-')
  const body = neg ? t.slice(1) : t
  const parts = body.split('.')
  const intPart = parts[0] ?? '0'
  const fracPart = parts[1] ?? ''
  if (fracPart.length > 4) throw new Error('too many decimals')
  const digits = intPart + fracPart.padEnd(4, '0')
  const val = BigInt(digits === '' ? '0' : digits)
  return neg ? -val : val
}

export function formatUsd(v: bigint): string {
  const neg = v < 0n
  const abs = neg ? -v : v
  const s = abs.toString().padStart(5, '0')
  const intPart = s.slice(0, -4) || '0'
  let frac = s.slice(-4)
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1)
  const out = `${intPart}.${frac}`
  return neg ? `-${out}` : out
}

export function centsFromUsd(v: bigint): number {
  return Number(roundDiv(v, 100n))
}

export function feeCents(price: bigint, shares: number, ppm: number): number {
  return Number(roundDiv(price * BigInt(shares) * BigInt(ppm), 100_000_000n))
}

export function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('divisor must be positive')
  // bigint / truncates toward zero, so only positive numerators need the +d-1 shift
  if (n >= 0n) return (n + d - 1n) / d
  return n / d
}

export function ceilCents(v: bigint): bigint {
  return ceilDiv(v, 100n) * 100n
}

export function floorCents(v: bigint): bigint {
  return (v / 100n) * 100n
}
