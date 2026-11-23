DROP INDEX `sim_days_sim_run_idx` ON `sim_days`;--> statement-breakpoint
ALTER TABLE `orders` ADD `reported_at` timestamp;--> statement-breakpoint
CREATE INDEX `sim_days_sim_run_trade_idx` ON `sim_days` (`sim_run_id`,`trade_date`);
--> statement-breakpoint
-- Hand-appended backfill: every order already stale before this migration counts as reported, so the first digest after deploy does not name the whole history.
UPDATE `orders` SET `reported_at` = NOW() WHERE `status` = 'stale';
