export type Lang = 'en' | 'ko'

export interface MsgEntry { en: string; ko: string }
// Notice codes (from computeOrders + day pipeline) covered here:
//   no-bucket-available, shares-zero (params.price), sell-capped (params.price), unconfirmed (params.count, params.date).
// Plus digest/bot chrome: header, trade-date, skip, age, age-forced, closed, reminder, start, help.
export const CATALOG: Record<string, MsgEntry> = {
  'no-bucket-available': { en: 'no bucket available', ko: '사용 가능한 버킷 없음' },
  'shares-zero': { en: 'shares zero', ko: '주식 수 0' },
  'sell-capped': { en: 'sell capped (price {price})', ko: '매도 상한 (가격 {price})' },
  'unconfirmed': { en: '⚠️ Unconfirmed orders from {date}: {count}', ko: '⚠️ {date} 미확인 주문 {count}건' },
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
  'warn-data-error': { en: 'Market data error — run #{id} {ticker}: last close unavailable or stale. Today\'s orders for this run could not be computed.', ko: '시세 데이터 오류 — 런 #{id} {ticker}: 최근 종가를 가져올 수 없습니다. 오늘 런의 주문을 계산할 수 없습니다.' },
  'warn-pipeline-error': { en: 'Morning pipeline error — the pipeline stopped before any run was planned. Check the server log, then run the morning pipeline again.', ko: '아침 파이프라인 오류 — 런을 하나도 계획하지 못하고 중단되었습니다. 서버 로그를 확인한 뒤 아침 파이프라인을 다시 실행하세요.' },
  'warn-run-error': { en: 'Morning pipeline error — run #{id} {ticker}: today\'s orders could not be planned. Check this run\'s Orders tab in the web app; if today\'s orders are missing, run the morning pipeline again.', ko: '아침 파이프라인 오류 — 런 #{id} {ticker}: 오늘 주문을 계획하지 못했습니다. 웹 앱에서 이 런의 주문 탭을 확인하고, 오늘 주문이 없으면 아침 파이프라인을 다시 실행하세요.' },
  'run-already-planned': { en: 'ℹ️ Run #{id} {ticker}: today\'s orders were already planned, so this run was not planned again.', ko: 'ℹ️ 런 #{id} {ticker}: 오늘 주문이 이미 계획되어 있어 다시 계획하지 않았습니다.' },
  'capture-booked': { en: 'Booked {ticker} {side} {shares} sh @ ${price} on {date} — confirm?', ko: '{ticker} {side} {shares}주 @ ${price} ({date}) 예약 — 확인하시겠습니까?' },
  'booked': { en: 'Booked {ticker} {side} {shares} sh @ ${price} on {date} into bucket {bucket}', ko: '{ticker} {side} {shares}주 @ ${price} ({date})을(를) 버킷 {bucket}에 예약했습니다' },
  'booked-no-bucket': { en: 'Booked {ticker} {side} {shares} sh @ ${price} on {date}', ko: '{ticker} {side} {shares}주 @ ${price} ({date})을(를) 예약했습니다' },
  'rejected-line': { en: 'Rejected — fill discarded.', ko: '거부됨 — 체결이 폐기되었습니다.' },
  'duplicate-capture': { en: 'Duplicate capture — all fills already booked or pending, or a correction is waiting in Pending.', ko: '중복 스냅샷 — 모든 체결이 이미 예약되었거나 대기 중이거나, 수정 제안이 \'확인 대기\'에 있습니다.' },
  'capture-conflicts-head': { en: 'Conflicts — these were not booked:', ko: '충돌 — 아래 체결은 예약되지 않았습니다:' },
  'capture-conflict': { en: '⚠️ Conflict: {side} {shares} {ticker} on {date} — extracted ${extracted}, booked fill #{id} has ${dupPrice}. Correction listed in Pending.', ko: '⚠️ 충돌: {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 예약된 체결 #{id} 가격 ${dupPrice}. 수정 제안은 \'확인 대기\'에서 처리하세요.' },
  'capture-conflict-dismissed': { en: 'ℹ️ {side} {shares} {ticker} on {date} — extracted ${extracted}, booked fill #{id} has ${dupPrice}. You dismissed this correction before; not listed again.', ko: 'ℹ️ {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 예약된 체결 #{id} 가격 ${dupPrice}. 이전에 무시한 수정 제안이므로 다시 표시하지 않습니다.' },
  'capture-conflict-gone': { en: '⚠️ {side} {shares} {ticker} on {date} — extracted ${extracted}, but booked fill #{id} no longer exists. Nothing to correct.', ko: '⚠️ {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 예약된 체결 #{id}이(가) 더 이상 없습니다. 수정할 항목이 없습니다.' },
  'capture-conflict-pending': { en: '⚠️ Conflict: {side} {shares} {ticker} on {date} — extracted ${extracted}, but pending row #{id} has ${dupPrice}. Resolve that row first.', ko: '⚠️ 충돌: {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 대기 중 행 #{id} 가격 ${dupPrice}. 먼저 해당 행을 처리하세요.' },
  'capture-booked-earlier': { en: 'ℹ️ Fills from this image were already confirmed earlier — the rows below may be duplicates. Check before confirming.', ko: 'ℹ️ 이 이미지의 체결은 이전에 이미 확정되었습니다 — 아래 항목은 중복일 수 있으니 확인 후 확정하세요.' },
  'capture-date-substituted': { en: '⚠️ No usable trade date was read from the screenshot, so the capture date {date} was used. Check the date and confirm this fill in the web app\'s Pending view.', ko: '⚠️ 스크린샷에서 사용할 수 있는 거래일을 읽지 못해 캡처한 날짜 {date}을(를) 사용했습니다. 웹 앱의 \'확인 대기\'에서 날짜를 확인한 뒤 이 체결을 확정하세요.' },
  'capture-date-after-today': { en: '⚠️ The trade date read from the screenshot ({date}) is after today. Fix the date and confirm this fill in the web app\'s Pending view.', ko: '⚠️ 스크린샷에서 읽은 거래일({date})이 미래 날짜입니다. 웹 앱의 \'확인 대기\'에서 날짜를 수정한 뒤 이 체결을 확정하세요.' },
  'capture-needs-bucket': { en: '⚠️ The tracker cannot tell which bucket sold this. Choose the bucket and confirm this fill in the web app\'s Pending view.', ko: '⚠️ 이 매도가 어느 버킷의 것인지 알 수 없습니다. 웹 앱의 \'확인 대기\'에서 버킷을 선택한 뒤 이 체결을 확정하세요.' },
  'capture-bad-extract-http': { en: 'The vision service did not accept the request.', ko: '비전 서비스가 요청을 받아들이지 않았습니다.' },
  'capture-bad-extract-incompatible': { en: 'The vision service answered, but not as an OpenAI-compatible API.', ko: '비전 서비스가 응답했지만 OpenAI 호환 API 형식이 아닙니다.' },
  'capture-bad-extract-unparseable': { en: 'The vision model answered, but not in a form the tracker understands — {detail}. Try again; if it keeps happening, check the vision model.', ko: '비전 모델이 응답했지만 트래커가 이해할 수 있는 형식이 아닙니다 — {detail}. 다시 시도하고, 계속 반복되면 비전 모델을 확인하세요.' },
  'capture-bad-extract-empty': { en: 'No fills were found in this image. Check that it shows the fills list, or book the fill manually.', ko: '이 이미지에서 체결을 찾지 못했습니다. 체결 내역 화면인지 확인하거나 체결을 직접 예약하세요.' },
  'capture-vision-in-use': { en: 'In use: model {model} ({modelSource}), URL {baseUrl} ({baseUrlSource}), key ({keySource}).', ko: '사용 중: 모델 {model} ({modelSource}), URL {baseUrl} ({baseUrlSource}), 키 ({keySource}).' },
  'capture-vision-setup-advice': { en: 'This is a vision setup problem, not the screenshot. A URL or model changed in Settings applies after a server restart.', ko: '스크린샷 문제가 아니라 비전 설정 문제입니다. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.' },
  'capture-vision-incompatible-advice': { en: 'Make sure the configured vision API is OpenAI-compatible. A URL or model changed in Settings applies after a server restart.', ko: '설정된 비전 API가 OpenAI 호환인지 확인하세요. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.' },
  'capture-vision-original-error': { en: 'Original error: {detail}', ko: '원본 오류: {detail}' },
  'vision-source-settings': { en: 'Settings', ko: '설정' },
  'vision-source-env': { en: 'env', ko: '환경변수' },
  'vision-source-none': { en: 'not set', ko: 'API Key 없음' },
  'capture-no-run': { en: 'No active run for {ticker} — use /capture <runId> to pick one.', ko: '{ticker}에 대한 활성 런이 없습니다 — /capture <runId>로 선택하세요.' },
  'capture-ambiguous': { en: 'Multiple active runs for {ticker} — use /capture <runId>.', ko: '{ticker}에 여러 활성 런이 있습니다 — /capture <runId>를 사용하세요.' },
  'capture-pin-skipped': { en: 'Ignored {tickers} — not the ticker of run #{id}.', ko: '{tickers}은(는) 런 #{id}의 종목이 아니므로 무시했습니다.' },
  'capture-pin-nomatch': { en: 'No {ticker} fills in this image — run #{id} unchanged.', ko: '이 이미지에서 {ticker} 체결을 찾지 못했습니다 — 런 #{id}는 그대로입니다.' },
  'confirm-err-ticker-mismatch': { en: 'Ticker does not match the run — tap No to reject this fill, then re-capture.', ko: '티커가 런과 일치하지 않습니다 — \'No\'를 눌러 이 체결을 거부하고 다시 캡처하세요.' },
  'confirm-err-already-handled': { en: 'Already handled — this fill was already confirmed or rejected.', ko: '이미 처리되었습니다 — 이 체결은 이미 확정되었거나 거부되었습니다.' },
  'confirm-err-no-empty-bucket': { en: 'No empty bucket left in this run — free one up before confirming.', ko: '이 런에 빈 버킷이 없습니다 — 확정하기 전에 버킷을 비우세요.' },
  'confirm-err-no-bucket-for-sell': { en: 'No held bucket can cover this sell — check the share count.', ko: '이 매도를 처리할 수 있는 보유 버킷이 없습니다 — 수량을 확인하세요.' },
  'confirm-err-too-many-shares': { en: 'More shares than the position holds.', ko: '보유 수량을 초과합니다.' },
  'confirm-err-invalid-shares': { en: 'Invalid share count.', ko: '유효하지 않은 수량입니다.' },
  'confirm-err-invalid-side': { en: 'Invalid side — use buy or sell.', ko: '유효하지 않은 매매 구분입니다 — buy 또는 sell을 사용하세요.' },
  'confirm-err-invalid-fee': { en: 'Invalid fee — use a whole number of cents, 0 or more.', ko: '유효하지 않은 수수료입니다 — 0 이상의 정수(센트)를 사용하세요.' },
  'confirm-err-bucket-not-held': { en: 'The matched bucket is not currently held — check the side and the share count.', ko: '매칭된 버킷이 현재 보유 중이 아닙니다 — 매매 구분과 수량을 확인하세요.' },
  'confirm-err-bucket-not-found': { en: 'That bucket no longer exists on this run; book it from the web Pending view.', ko: '이 런에 해당 버킷이 더 이상 없습니다. 웹의 대기 목록에서 처리하세요.' },
  'confirm-err-fill-date-in-future': { en: 'The trade date is after today — fix the date in the web app\'s Pending view.', ko: '체결 날짜가 미래 날짜입니다 — 웹 앱의 \'확인 대기\'에서 날짜를 수정하세요.' },
  'confirm-err-choose-bucket': { en: 'The tracker cannot tell which bucket sold this — choose the bucket in the web app\'s Pending view.', ko: '이 매도가 어느 버킷의 것인지 알 수 없습니다 — 웹 앱의 \'확인 대기\'에서 버킷을 선택하세요.' },
  'confirm-err-unknown': { en: 'Could not confirm this fill ({code}).', ko: '이 체결을 확정할 수 없습니다 ({code}).' },
  'unknown-run': { en: 'No run with id {id}.', ko: 'id {id}인 런이 없습니다.' },
  'no-runs': { en: 'No runs yet — start one from the web app.', ko: '아직 런이 없습니다 — 웹 앱에서 시작하세요.' },
  'status-run-line': { en: 'Run #{id} {ticker}', ko: '런 #{id} {ticker}' },
  'status-cash': { en: 'Cash: ${amount}', ko: '현금: ${amount}' },
  'no-orders': { en: 'No orders due on {date}.', ko: '{date}에 만료된 주문이 없습니다.' },
  'orders-line': { en: '#{id} {kind} {shares} sh @ ${price}', ko: '#{id} {kind} {shares}주 @ ${price}' },
  'orders-run-missing': { en: 'run #{id}', ko: '런 #{id}' },
  'bucket-idle': { en: 'Bucket {index}: idle', ko: '버킷 {index}: 유휴' },
  'bucket-held': { en: 'Bucket {index}: held {shares} sh @ ${price}', ko: '버킷 {index}: {shares}주 보유 @ ${price}' },
  'bucket-force-sell': { en: 'Bucket {index}: FORCE SELL {shares} sh @ ${price}', ko: '버킷 {index}: 강제 매도 {shares}주 @ ${price}' },
  'vision-not-configured': { en: 'Vision is not configured — set VISION_BASE_URL and VISION_MODEL.', ko: '비전 설정이 없습니다 — VISION_BASE_URL과 VISION_MODEL을 설정하세요.' },
  'order-cancelled': { en: '🚫 Cancelled: {kind} bucket {bucket} — {reason} ({price})', ko: '🚫 취소: {kind} 버킷 {bucket} — {reason} ({price})' },
  'sibling-cancelled': { en: '⚠️ Run #{id} {ticker}: cancel bucket {bucket} {leg} (${limit}) at your broker — the other leg already filled, so this order is no longer needed.', ko: '⚠️ 런 #{id} {ticker}: 증권사에서 버킷 {bucket} {leg} (${limit}) 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.' },
  'sibling-cancelled-market': { en: '⚠️ Run #{id} {ticker}: cancel bucket {bucket} {leg} at your broker — the other leg already filled, so this order is no longer needed.', ko: '⚠️ 런 #{id} {ticker}: 증권사에서 버킷 {bucket} {leg} 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.' },
  'buy-removed-cancelled': { en: '⚠️ Run #{id} {ticker}: cancel bucket {bucket} {leg} (${limit}) at your broker — the buy it was placed for was deleted, so this order is no longer needed.', ko: '⚠️ 런 #{id} {ticker}: 증권사에서 버킷 {bucket} {leg} (${limit}) 주문을 취소하세요 — 이 주문의 근거였던 매수 체결이 삭제되어 더 이상 필요하지 않습니다.' },
  'buy-removed-cancelled-market': { en: '⚠️ Run #{id} {ticker}: cancel bucket {bucket} {leg} at your broker — the buy it was placed for was deleted, so this order is no longer needed.', ko: '⚠️ 런 #{id} {ticker}: 증권사에서 버킷 {bucket} {leg} 주문을 취소하세요 — 이 주문의 근거였던 매수 체결이 삭제되어 더 이상 필요하지 않습니다.' },
  'leg-sell_loc': { en: 'target', ko: '목표가 매도' },
  'leg-stop_sell': { en: 'stop', ko: '손절 매도' },
  'leg-market_sell': { en: 'market sell', ko: '시장가 매도' },
  'sell-attributed-alt': { en: 'bucket {bucket} {leg} (${limit}, ${distance} away)', ko: '버킷 {bucket} {leg} (${limit}, ${distance} 차이)' },
  'sell-attributed-alt-market': { en: 'bucket {bucket} {leg}', ko: '버킷 {bucket} {leg}' },
  'sell-attributed': {
    en: 'ℹ️ Run #{id} {ticker}: sell {shares} sh @ ${price} was booked to {chosen}. Also possible: {alts}. {why}',
    ko: 'ℹ️ 런 #{id} {ticker}: 매도 {shares}주 @ ${price} 체결을 {chosen}에 기록했습니다. 다른 후보: {alts}. {why}',
  },
  'sell-attributed-why-order-price': {
    en: 'More than one order of this type could have filled; the one whose limit is nearest the order price on the screenshot was chosen.',
    ko: '체결된 주문으로 볼 수 있는 이 유형의 주문이 둘 이상입니다. 스크린샷의 주문단가에 지정가가 가장 가까운 주문을 선택했습니다.',
  },
  'sell-attributed-why-ordered-shares': {
    en: 'More than one order of this type could have filled; the one placed for the ordered quantity on the screenshot was chosen.',
    ko: '체결된 주문으로 볼 수 있는 이 유형의 주문이 둘 이상입니다. 스크린샷의 주문수량으로 낸 주문을 선택했습니다.',
  },
  'sell-attributed-why-shares': {
    en: 'More than one order of this type could have filled; the bucket holding exactly {shares} shares was chosen.',
    ko: '체결된 주문으로 볼 수 있는 이 유형의 주문이 둘 이상입니다. 정확히 {shares}주를 보유한 버킷을 선택했습니다.',
  },
  'sell-attributed-why-price': {
    en: 'More than one order of this type could have filled; the one whose price is nearest the fill price was chosen.',
    ko: '체결된 주문으로 볼 수 있는 이 유형의 주문이 둘 이상입니다. 가격이 체결가에 가장 가까운 주문을 선택했습니다.',
  },
  'sell-attributed-why-older': {
    en: 'More than one order of this type could have filled and nothing else told them apart; the bucket bought earliest was chosen.',
    ko: '체결된 주문으로 볼 수 있는 이 유형의 주문이 둘 이상이고 다른 단서로는 구분할 수 없어, 가장 먼저 매수한 버킷을 선택했습니다.',
  },
  'cut-loss-immediate': { en: '⚠️ {n} stop trigger(s) already at or above the last close — the stop may fire as soon as it is placed', ko: '⚠️ 손절 발동가 {n}건이 이미 최근 종가 이상입니다 — 주문하자마자 체결될 수 있습니다' },
  'stop-verb': { en: 'Sell', ko: '매도' },
  'stop-label': { en: 'trigger', ko: '발동가' },
  'reason-broker-filled': { en: 'filled elsewhere at broker', ko: '증권사에서 별도 체결' },
  'reason-strategy-change': { en: 'strategy change', ko: '전략 변경' },
  'reason-stale-price': { en: 'price no longer valid', ko: '가격 무효화' },
  'reason-other': { en: 'other', ko: '기타' },
}

export function t(code: string, lang: Lang, params?: Record<string, string | number>): string {
  const entry = CATALOG[code]
  const base = entry ? entry[lang] : code
  if (!params) return base
  return base.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
}

// Buckets are stored 0-based (Bucket.index, bucket_idx, bucketIndex). Every text shown to
// the operator numbers them from 1, like the web bucket board: pass bucketNo(index) as the
// {bucket} / {index} param, never the raw index.
export function bucketNo(index: number): number {
  return index + 1
}
