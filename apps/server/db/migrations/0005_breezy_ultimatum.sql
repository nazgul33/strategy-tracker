CREATE TABLE `price_history` (
	`ticker` varchar(16) NOT NULL,
	`trade_date` date NOT NULL,
	`close` bigint NOT NULL,
	CONSTRAINT `price_history_ticker_trade_date_pk` PRIMARY KEY(`ticker`,`trade_date`)
);
