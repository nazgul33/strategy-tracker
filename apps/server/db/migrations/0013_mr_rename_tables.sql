RENAME TABLE IF EXISTS
	`pool_edits` TO `mr_pool_edits`,
	`buckets` TO `mr_buckets`,
	`orders` TO `mr_orders`,
	`fills` TO `mr_fills`,
	`ledger` TO `mr_ledger`,
	`pending_fills` TO `mr_pending_fills`,
	`fill_corrections` TO `mr_fill_corrections`,
	`vision_reviews` TO `mr_vision_reviews`,
	`sim_runs` TO `mr_sim_runs`,
	`sim_days` TO `mr_sim_days`;
--> statement-breakpoint
ALTER TABLE `mr_orders` RENAME INDEX IF EXISTS `orders_run_trade_date_idx` TO `mr_orders_run_trade_date_idx`;
--> statement-breakpoint
ALTER TABLE `mr_orders` RENAME INDEX IF EXISTS `orders_trade_date_idx` TO `mr_orders_trade_date_idx`;
--> statement-breakpoint
ALTER TABLE `mr_vision_reviews` RENAME INDEX IF EXISTS `vision_reviews_pending_fill_unique` TO `mr_vision_reviews_pending_fill_unique`;
--> statement-breakpoint
ALTER TABLE `mr_vision_reviews` RENAME INDEX IF EXISTS `vision_reviews_capture_idx` TO `mr_vision_reviews_capture_idx`;
--> statement-breakpoint
ALTER TABLE `mr_fill_corrections` RENAME INDEX IF EXISTS `fill_corrections_fill_idx` TO `mr_fill_corrections_fill_idx`;
--> statement-breakpoint
ALTER TABLE `mr_sim_runs` RENAME INDEX IF EXISTS `sim_runs_draft_created_idx` TO `mr_sim_runs_draft_created_idx`;
--> statement-breakpoint
ALTER TABLE `mr_sim_days` RENAME INDEX IF EXISTS `sim_days_sim_run_trade_idx` TO `mr_sim_days_sim_run_trade_idx`;
