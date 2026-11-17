CREATE TABLE `capture_images` (
	`capture_id` int NOT NULL,
	`mime` varchar(32) NOT NULL,
	`bytes` longblob NOT NULL,
	`byte_len` int NOT NULL,
	`keep` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capture_images_capture_id` PRIMARY KEY(`capture_id`)
);
--> statement-breakpoint
CREATE TABLE `vision_reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`capture_id` int NOT NULL,
	`pending_fill_id` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`outcome` enum('confirmed','rejected') NOT NULL,
	`detected_side` varchar(8),
	`detected_shares` int,
	`detected_price` bigint,
	`detected_filled_on` date,
	`detected_fee` int,
	`final_side` varchar(8),
	`final_shares` int,
	`final_price` bigint,
	`final_filled_on` date,
	`final_fee` int,
	`edited` boolean NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vision_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `vision_reviews_pending_fill_unique` UNIQUE(`pending_fill_id`)
);
--> statement-breakpoint
ALTER TABLE `pending_fills` ADD `detected_side` varchar(8);--> statement-breakpoint
ALTER TABLE `pending_fills` ADD `detected_shares` int;--> statement-breakpoint
ALTER TABLE `pending_fills` ADD `detected_price` bigint;--> statement-breakpoint
ALTER TABLE `pending_fills` ADD `detected_filled_on` date;--> statement-breakpoint
ALTER TABLE `pending_fills` ADD `detected_fee` int;--> statement-breakpoint
ALTER TABLE `pending_fills` ADD `detected_at` timestamp;--> statement-breakpoint
CREATE INDEX `vision_reviews_capture_idx` ON `vision_reviews` (`capture_id`);