CREATE TABLE IF NOT EXISTS `mr_runs` (
	`run_id` int NOT NULL,
	`pool_cents` int NOT NULL,
	`buy_gap_ppm` int NOT NULL DEFAULT 0,
	`sell_gap_ppm` int NOT NULL DEFAULT 0,
	`cut_loss_ppm` int NOT NULL DEFAULT 0,
	`state_json` text NOT NULL,
	CONSTRAINT `mr_runs_run_id` PRIMARY KEY(`run_id`)
);
--> statement-breakpoint
INSERT INTO `mr_runs` (`run_id`, `pool_cents`, `buy_gap_ppm`, `sell_gap_ppm`, `cut_loss_ppm`, `state_json`)
SELECT `id`, `pool_cents`, `buy_gap_ppm`, `sell_gap_ppm`, `cut_loss_ppm`, `state_json` FROM `strategy_runs`
ON DUPLICATE KEY UPDATE `pool_cents` = VALUES(`pool_cents`), `buy_gap_ppm` = VALUES(`buy_gap_ppm`), `sell_gap_ppm` = VALUES(`sell_gap_ppm`), `cut_loss_ppm` = VALUES(`cut_loss_ppm`), `state_json` = VALUES(`state_json`);
