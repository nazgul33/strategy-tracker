CREATE TABLE `bar_coverage` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`from_date` date NOT NULL,
	`to_date` date NOT NULL,
	CONSTRAINT `bar_coverage_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `orders` MODIFY COLUMN `kind` enum('buy_loc','sell_loc','market_sell','stop_sell') NOT NULL;--> statement-breakpoint
ALTER TABLE `price_history` ADD `open` bigint;--> statement-breakpoint
ALTER TABLE `price_history` ADD `high` bigint;--> statement-breakpoint
ALTER TABLE `price_history` ADD `low` bigint;--> statement-breakpoint
ALTER TABLE `sim_runs` ADD `cut_loss_ppm` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sim_runs` ADD `draft` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_runs` ADD `cut_loss_ppm` int DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `bar_coverage_ticker_idx` ON `bar_coverage` (`ticker`);--> statement-breakpoint
-- Hand-appended backfill: `draft` defaults to true for new rows, but every sim run that existed before this migration is saved history, not a draft.
UPDATE `sim_runs` SET `draft` = 0;