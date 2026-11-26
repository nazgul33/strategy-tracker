CREATE TABLE `capture_choices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`chat_id` varchar(64) NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`mr_run_id` int NOT NULL,
	`vr_run_id` int NOT NULL,
	`fills_json` text NOT NULL,
	`image_base64` longtext NOT NULL,
	`image_mime` varchar(32) NOT NULL,
	`read_on` date NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`answer` enum('mr','vr','both'),
	`answered_at` timestamp,
	CONSTRAINT `capture_choices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `vr_pending_fills` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`capture_id` int NOT NULL,
	`side` varchar(8) NOT NULL,
	`shares` int NOT NULL,
	`price` bigint NOT NULL,
	`fee` int,
	`filled_on` date NOT NULL,
	`date_read` boolean NOT NULL,
	`dup_price` bigint,
	`status` enum('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vr_pending_fills_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `vr_pending_fills_run_status_idx` ON `vr_pending_fills` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `vr_pending_fills_capture_idx` ON `vr_pending_fills` (`capture_id`);