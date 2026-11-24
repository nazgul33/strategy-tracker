export type SellOrderType = 'target' | 'stop' | 'market' | 'unknown'
export interface OrderEvidence { type: SellOrderType; orderPrice: bigint | null; orderedShares: number | null }
export const NO_EVIDENCE: OrderEvidence = { type: 'unknown', orderPrice: null, orderedShares: null }

// The broker's order-type text ("매도/STOP(시장가)", "매도/LOC", ...). The tests run in this
// order, so a stop-market is a stop and a market sell is never a target.
export function classifyOrderType(raw: string | null | undefined): SellOrderType {
  const text = (raw ?? '').replace(/\s+/g, '').toUpperCase()
  if (!text.includes('매도') || text.includes('정정')) return 'unknown'
  if (text.includes('STOP')) return 'stop'
  if (text.includes('시장가')) return 'market'
  if (text.includes('LOC') || text.includes('보통')) return 'target'
  return 'unknown'
}

export function kindOfType(type: SellOrderType): 'sell_loc' | 'stop_sell' | 'market_sell' | null {
  switch (type) {
    case 'target': return 'sell_loc'
    case 'stop': return 'stop_sell'
    case 'market': return 'market_sell'
    default: return null
  }
}

export function evidenceOf(row: { detectedOrderType?: string | null; detectedOrderPrice?: bigint | null; detectedOrderedShares?: number | null }): OrderEvidence {
  return { type: classifyOrderType(row.detectedOrderType), orderPrice: row.detectedOrderPrice ?? null, orderedShares: row.detectedOrderedShares ?? null }
}
