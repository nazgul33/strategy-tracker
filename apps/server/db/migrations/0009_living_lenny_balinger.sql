CREATE INDEX `orders_run_trade_date_idx` ON `orders` (`run_id`,`trade_date`);--> statement-breakpoint
CREATE INDEX `orders_trade_date_idx` ON `orders` (`trade_date`);--> statement-breakpoint
CREATE INDEX `sim_days_sim_run_idx` ON `sim_days` (`sim_run_id`);--> statement-breakpoint
CREATE INDEX `sim_runs_draft_created_idx` ON `sim_runs` (`draft`,`created_at`);