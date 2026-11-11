ALTER TABLE `sim_runs` ADD `buy_gap_ppm` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sim_runs` ADD `sell_gap_ppm` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_runs` ADD `buy_gap_ppm` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_runs` ADD `sell_gap_ppm` int DEFAULT 0 NOT NULL;