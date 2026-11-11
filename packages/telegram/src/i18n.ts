export type Lang = 'en' | 'ko'

export interface MsgEntry { en: string; ko: string }
// Notice codes (from computeOrders + day pipeline) covered here:
//   no-bucket-available, shares-zero (params.price), unconfirmed (params.count, params.date).
// Plus digest/bot chrome: header, trade-date, skip, age, age-forced, closed, reminder, start, help.
export const CATALOG: Record<string, MsgEntry> = {
  'no-bucket-available': { en: 'no bucket available', ko: '사용 가능한 버킷 없음' },
  'shares-zero': { en: 'shares zero', ko: '주식 수 0' },
  'unconfirmed': { en: '⚠️ {count} unconfirmed orders from {date}', ko: '⚠️ {date} 미확인 주문 {count}건' },
  'header': { en: '{name}  {ticker}', ko: '{name}  {ticker}' },
  'trade-date': { en: 'Trade date: {date}  Last close: {price} ({lastDate})', ko: '거래일: {date}  최근 종가: {price} ({lastDate})' },
  'skip': { en: 'SKIP', ko: '건너뜀' },
  'age': { en: 'age {n}', ko: '{n}일 경과' },
  'age-forced': { en: 'age {n} — forced exit', ko: '{n}일 경과 — 강제 청산' },
  'closed': { en: 'Market closed', ko: '시장 휴장' },
  'closed-named': { en: 'Market closed ({name})', ko: '시장 휴장 ({name})' },
  'reminder': { en: '16:05 fill capture reminder', ko: '16:05 체결 캡처 알림' },
  'start': { en: 'ok', ko: 'ok' },
  'help': { en: 'help', ko: 'help' },
  'december-nudge': { en: 'December — time to load next year\'s NYSE calendar', ko: '12월입니다 — 내년 NYSE 휴장 캘린더를 업데이트하세요' },
  'warn-conflict': { en: 'Calendar conflict — local and remote calendars disagree. No orders today, please check manually', ko: '캘린더 불일치 — 로컬·원격 캘린더가 엇갈립니다. 오늘 주문을 내지 말고 확인해 주세요' },
  'warn-data-error': { en: 'Market data error — last close unavailable or stale. No orders today', ko: '시세 데이터 오류 — 최근 종가를 가져올 수 없습니다. 오늘 주문을 내지 마세요' },
  'capture-booked': { en: 'Booked {ticker} {side} {shares} sh @ ${price} — confirm?', ko: '{ticker} {side} {shares}주 @ ${price} 예약 — 확인하시겠습니까?' },
  'booked': { en: 'Booked {ticker} {side} {shares} sh @ ${price} into bucket {bucket}', ko: '{ticker} {side} {shares}주 @ ${price}을(를) 버킷 {bucket}에 예약했습니다' },
  'rejected-line': { en: 'Rejected — fill discarded.', ko: '거부됨 — 체결이 폐기되었습니다.' },
  'duplicate-capture': { en: 'Duplicate capture — already booked.', ko: '중복 스냅샷 — 이미 예약되었습니다.' },
  'capture-bad-extract': { en: 'Could not read fills from this image — {detail}. Book the fill manually in the web UI.', ko: '이미지에서 체결을 읽을 수 없습니다 — {detail}. 웹 UI에서 직접 예약해 주세요.' },
  'capture-no-run': { en: 'No active run for {ticker} — use /capture <runId> to pick one.', ko: '{ticker}에 대한 활성 런이 없습니다 — /capture <runId>로 선택하세요.' },
  'capture-ambiguous': { en: 'Multiple active runs for {ticker} — use /capture <runId>.', ko: '{ticker}에 여러 활성 런이 있습니다 — /capture <runId>를 사용하세요.' },
  'capture-pin-skipped': { en: 'Ignored {tickers} — not the ticker of run #{id}.', ko: '{tickers}은(는) 런 #{id}의 종목이 아니므로 무시했습니다.' },
  'capture-pin-nomatch': { en: 'No {ticker} fills in this image — run #{id} unchanged.', ko: '이 이미지에서 {ticker} 체결을 찾지 못했습니다 — 런 #{id}는 그대로입니다.' },
  'unknown-run': { en: 'No run with id {id}.', ko: 'id {id}인 런이 없습니다.' },
  'no-runs': { en: 'No runs yet — start one from the web app.', ko: '아직 런이 없습니다 — 웹 앱에서 시작하세요.' },
  'status-run-line': { en: 'Run #{id} {ticker}', ko: '런 #{id} {ticker}' },
  'status-cash': { en: 'Cash: ${amount}', ko: '현금: ${amount}' },
  'no-orders': { en: 'No orders due on {date}.', ko: '{date}에 만료된 주문이 없습니다.' },
  'orders-line': { en: '#{id} {kind} {ticker} {shares} sh @ ${price}', ko: '#{id} {kind} {ticker} {shares}주 @ ${price}' },
  'bucket-idle': { en: 'Bucket {index}: idle', ko: '버킷 {index}: 유휴' },
  'bucket-held': { en: 'Bucket {index}: held {shares} sh @ ${price}', ko: '버킷 {index}: {shares}주 보유 @ ${price}' },
  'bucket-force-sell': { en: 'Bucket {index}: FORCE SELL {shares} sh @ ${price}', ko: '버킷 {index}: 강제 매도 {shares}주 @ ${price}' },
  'vision-not-configured': { en: 'Vision is not configured — set VISION_BASE_URL and VISION_MODEL.', ko: '비전 설정이 없습니다 — VISION_BASE_URL과 VISION_MODEL을 설정하세요.' },
}

export function t(code: string, lang: Lang, params?: Record<string, string | number>): string {
  const entry = CATALOG[code]
  const base = entry ? entry[lang] : code
  if (!params) return base
  return base.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
}
