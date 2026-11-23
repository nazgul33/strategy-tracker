export const MPOP_FILL_EXTRACTION_PROMPT = `You are extracting trade fills from a Samsung Securities (삼성증권) mPOP overseas-stock execution history (해외주식매매내역) screenshot. It is either a 당일체결 (single-day) or a 기간체결 (date-range) view.

The screenshot is a WIDE table: one row per order, columns include:
종목코드 (ticker) · 주문수량 (ordered shares) · 체결수량 (executed shares) · 미체결수량 (remaining shares) · 주문구분 (order type, e.g. "매수 보통", "매수/LOC", "매도 LOO") · 주문단가 (order price) · 체결단가 (executed price) · 주문시간 (time of day only, e.g. "22:00:25" — never a date). A 기간체결 table may additionally show per-row date columns: the TRADE date (체결일 / 주문일 / "Trade Date") and the SETTLEMENT date (결제일 / 정산일 / "Settlement Date").

Output ONE fill per table row that has 체결수량 > 0:
- side: "buy" if 주문구분 contains 매수, "sell" if it contains 매도. Ignore the rest of the 주문구분 text (보통, LOO, 지정가, …).
- ticker: the symbol from 종목코드 WITHOUT the exchange suffix: a 기간체결 table shows "SOXL.N" — output "SOXL" (drop the ".N" / ".O" / ".A" exchange code; e.g. "BRK.B" keeps its ".B").
- shares: 체결수량 ONLY — never 주문수량 or 미체결수량.
- price: 체결단가 ONLY — NEVER 주문단가; they often differ (e.g. ordered 42.8400 but executed 56.8600).
- If 체결수량 is 0 or blank, that order has NOT been executed: skip the row entirely.
- Rows may repeat the same ticker at different prices: emit one fill per row.
- Numbers may use thousands separators ("1,268") and up to 4 decimals ("77.7300"): emit them without commas.
- fee: include ONLY if the screenshot explicitly shows a fee (수수료/제비용); otherwise omit.
- orderType: the 주문구분 text of the row, copied EXACTLY as shown, e.g. "매도/보통(지정가)", "매도/STOP(시장가)", "매도/STOP(지정가)", "매도/LOC", "정정(매도)". Keep the parentheses and slashes; an amended order shows "정정(매도)" or "정정(매수)".
- orderPrice: the 주문단가 of the row (the price the order was placed at, NOT 체결단가), e.g. "64.0700". A market order may show "0.0000": copy it as is.
- orderedShares: the 주문수량 of the row (NOT 체결수량).
- Omit orderType, orderPrice and orderedShares when their column is not in the table (the 기간체결 view usually has none of them). Never guess them.
- date: the TRADE date of each fill, as "YYYY-MM-DD".
  - 당일체결 (single-day) view: rows carry no date — take the 일자 (date) field in the top filter bar (e.g. "일자 2026-11-13"). It is usually already "YYYY-MM-DD": copy it verbatim and use the SAME date for every fill.
  - 기간체결 (date-range) view: each row carries its own date(s) — use the row's TRADE date (체결일 / 주문일 / "Trade Date"). NEVER output the SETTLEMENT date (결제일 / 정산일 / "Settlement Date"): it is a later, different date. If a row shows two dates and the labels are unclear, the trade date is the EARLIER one. Ignore the filter-bar 일자 in this view.
  - Any non-ISO form ("11.14", "2026.11.14", "Nov 14, 2026") must be converted to "YYYY-MM-DD"; resolve a missing year against Today.
  - Omit date only if no trade date is visible anywhere.

If the image is not an execution-history table (e.g. holdings 보유종목 list, an order screen, a menu) or shows no executed rows, emit {"fills":[]}.

Emit EXACTLY a JSON object of the form:
{"fills":[{"side":"buy","ticker":"SOXL","shares":"1268","price":"46.9768","date":"2026-11-14","orderType":"매수/LOC","orderPrice":"46.9768","orderedShares":"1268"}]}
- side must be "buy" or "sell".
- ticker is the symbol string.
- shares is a numeric string without commas (integer).
- price is a numeric string without commas.
- fee is an optional numeric string without commas.
- date is an optional "YYYY-MM-DD" string.
- orderType is an optional string, orderPrice an optional numeric string without commas, orderedShares an optional numeric string without commas (integer).
If there are no fill rows, emit {"fills":[]}. Output JSON only, no prose, no markdown fences.
`;
