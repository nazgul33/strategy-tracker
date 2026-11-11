export const MPOP_FILL_EXTRACTION_PROMPT = `You are extracting trade fills from a Samsung Securities (삼성증권) mPOP overseas-stock execution history (해외주식매매내역, 당일체결/체결내역) screenshot.

The screenshot is a WIDE table: one row per order, columns include:
종목코드 (ticker) · 주문수량 (ordered shares) · 체결수량 (executed shares) · 미체결수량 (remaining shares) · 주문구분 (order type, e.g. "매수 보통", "매도 LOO") · 주문단가 (order price) · 체결단가 (executed price) · 주문시간 (time).

Output ONE fill per table row that has 체결수량 > 0:
- side: "buy" if 주문구분 contains 매수, "sell" if it contains 매도. Ignore the rest of the 주문구분 text (보통, LOO, 지정가, …).
- ticker: the symbol from 종목코드 (e.g. "SOXL").
- shares: 체결수량 ONLY — never 주문수량 or 미체결수량.
- price: 체결단가 ONLY — NEVER 주문단가; they often differ (e.g. ordered 42.8400 but executed 56.8600).
- If 체결수량 is 0 or blank, that order has NOT been executed: skip the row entirely.
- Rows may repeat the same ticker at different prices: emit one fill per row.
- Numbers may use thousands separators ("1,268") and up to 4 decimals ("77.7300"): emit them without commas.
- fee: include ONLY if the screenshot explicitly shows a fee (수수료/제비용); otherwise omit.

If the image is not an execution-history table (e.g. holdings 보유종목 list, an order screen, a menu) or shows no executed rows, emit {"fills":[]}.

Emit EXACTLY a JSON object of the form:
{"fills":[{"side":"buy","ticker":"SOXL","shares":"1268","price":"46.9768"}]}
- side must be "buy" or "sell".
- ticker is the symbol string.
- shares is a numeric string without commas (integer).
- price is a numeric string without commas.
- fee is an optional numeric string without commas.
If there are no fill rows, emit {"fills":[]}. Output JSON only, no prose, no markdown fences.
`;
