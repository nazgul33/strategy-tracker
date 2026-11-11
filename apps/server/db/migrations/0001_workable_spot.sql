CREATE TABLE `settings` (
	`key` varchar(64) NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
ALTER TABLE `captures` MODIFY COLUMN `chat_id` varchar(64);--> statement-breakpoint
ALTER TABLE `pending_fills` MODIFY COLUMN `bucket_idx` int;--> statement-breakpoint
ALTER TABLE `pending_fills` MODIFY COLUMN `fee` int;