export type Lang = 'en' | 'ko'

export interface MsgEntry { en: string; ko: string }
// Notice codes (from computeOrders + day pipeline) covered here:
//   no-bucket-available, shares-zero (params.price), sell-capped (params.bucket, params.price),
//   unconfirmed (params.count, params.date).
// Plus digest/bot chrome: header, trade-date, skip, closed, reminder, start, help.
export const CATALOG: Record<string, MsgEntry> = {
  'no-bucket-available': { en: 'no bucket available', ko: '사용 가능한 버킷 없음' },
  'shares-zero': { en: 'shares zero', ko: '주식 수 0' },
  'sell-capped': { en: 'sell capped (price {price})', ko: '매도 상한 (가격 {price})' },
  'unconfirmed': { en: '⚠️ {count} unconfirmed orders from {date}', ko: '⚠️ {date} 미확인 주문 {count}건' },
  'header': { en: '{name}  {ticker}', ko: '{name}  {ticker}' },
  'trade-date': { en: 'Trade date: {date}  Last close: {price} ({lastDate})', ko: '거래일: {date}  최근 종가: {price} ({lastDate})' },
  'skip': { en: 'SKIP', ko: '건너뜀' },
  'closed': { en: 'Market closed', ko: '시장 휴장' },
  'closed-named': { en: 'Market closed ({name})', ko: '시장 휴장 ({name})' },
  'reminder': { en: '16:05 fill capture reminder', ko: '16:05 체결 캡처 알림' },
  'start': { en: 'ok', ko: 'ok' },
  'help': { en: 'help', ko: 'help' },
}

export function t(code: string, lang: Lang, params?: Record<string, string | number>): string {
  const entry = CATALOG[code]
  const base = entry ? entry[lang] : code
  if (!params) return base
  return base.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
}
