export const MPOP_FILL_EXTRACTION_PROMPT = `You are extracting trade fills from a Samsung Securities (삼성증권) mPOP execution history (체결내역) screenshot.

Labels in the screenshot (Korean):
- 매매구분: buy = 매수, sell = 매도
- 종목명/주문: ticker symbol
- 체결가: price per share
- 체결수량: number of shares
- 체결시간: execution time

One image group is provided per call. Extract every fill row. Emit EXACTLY a JSON object of the form:
{"fills":[{"side":"buy","ticker":"TSLA","shares":"120","price":"340.22","fee":"1.23"}]}
- side must be "buy" or "sell".
- ticker is the symbol string.
- shares is a numeric string without commas (integer).
- price is a numeric string without commas.
- fee is an optional numeric string without commas (omit if not shown).
If there are no fill rows, emit {"fills":[]}. Output JSON only, no prose, no markdown fences.
`;
