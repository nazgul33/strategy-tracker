CREATE TABLE `fill_corrections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`fill_id` int NOT NULL,
	`capture_id` int,
	`side` varchar(8) NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`booked_shares` int NOT NULL,
	`booked_filled_on` date NOT NULL,
	`booked_price` bigint NOT NULL,
	`booked_fee` int NOT NULL,
	`proposed_price` bigint NOT NULL,
	`proposed_fee` int,
	`status` enum('open','applied','dismissed') NOT NULL DEFAULT 'open',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fill_corrections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `fill_corrections_fill_idx` ON `fill_corrections` (`fill_id`);