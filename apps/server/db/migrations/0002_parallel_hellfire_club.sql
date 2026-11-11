UPDATE `strategy_runs` SET `status` = 'closed' WHERE `status` = 'done';--> statement-breakpoint
ALTER TABLE `strategy_runs` MODIFY COLUMN `status` enum('active','paused','closed') NOT NULL DEFAULT 'active';
